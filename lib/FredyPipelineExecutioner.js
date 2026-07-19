/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { NoNewListingsWarning, GeocodingUnavailableError } from './errors.js';
import Extractor from './services/extractor/extractor.js';
import urlModifier from './services/queryStringMutator.js';
import logger from './services/logger.js';
import { downloadAndOptimizeImages } from './services/pipeline/imageOptimizer.js';
import { enqueueCapture, isKnownSource } from './services/pipeline/queueStorage.js';

/** @import { ParsedListing } from './types/listing.js' */
/** @import { Job } from './types/job.js' */
/** @import { ProviderConfig } from './types/providerConfig.js' */
/** @import { Browser } from './types/browser.js' */

/**
 * Runtime producer for discovering and durably capturing new listings from a
 * configured provider. Parsing, filtering, persistence, and notification are
 * handled by independent workers after this producer returns.
 *
 * The execution flow is:
 * 1) Prepare provider URL (sorting, etc.)
 * 2) Extract raw listings from the provider
 * 3) Normalize listings to the provider schema
 * 4) Drop structurally broken rows (missing required/identifying fields)
 * 5) Identify new listings (vs. previously stored hashes)
 * 6) Capture complete provider detail evidence and optimize all gallery images
 * 7) Enqueue the self-contained capture for the continuous parser
 */
class FredyPipelineExecutioner {
  /**
   * Create a new runtime instance for a single provider/job execution.
   *
   * @param {ProviderConfig} providerConfig Provider configuration.
   * @param {Job} job Job configuration.
   * @param {string} providerId The ID of the provider currently in use.
   * @param {Browser} browser Puppeteer browser instance.
   */
  constructor(providerConfig, job, providerId, browser) {
    /** @type {ProviderConfig} */
    this._providerConfig = providerConfig;
    /** @type {string} */
    this._jobKey = job.id;
    /** @type {string} */
    this._providerId = providerId;
    /** @type {Browser} */
    this._browser = browser;
  }

  /**
   * Execute the scrape/capture producer for a single provider run.
   *
   * @returns {Promise<object[]|void>} Resolves to the queued captures;
   * resolves to void when there are no new listings.
   */
  execute() {
    return Promise.resolve(urlModifier(this._providerConfig.url, this._providerConfig.sortByDateParam))
      .then(this._providerConfig.getListings?.bind(this) ?? this._getListings.bind(this))
      .then(this._normalize.bind(this))
      .then(this._filter.bind(this))
      .then(this._findNew.bind(this))
      .then(this._captureAndEnqueue.bind(this))
      .catch(this._handleError.bind(this));
  }

  async _captureAndEnqueue(newListings) {
    if (typeof this._providerConfig.captureDetails !== 'function') {
      throw new Error(`Provider '${this._providerId}' does not implement captureDetails`);
    }
    const queued = [];
    const listingsToCapture = process.env.NODE_ENV === 'test' ? newListings.slice(0, 1) : newListings;
    for (const listing of listingsToCapture) {
      listing.discoveredAt = Date.now();
      try {
        let capture;
        let lastError;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            capture = await this._providerConfig.captureDetails(listing, this._browser);
            break;
          } catch (error) {
            lastError = error;
            if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
        if (!capture) throw lastError || new Error('Detail capture failed');
        const images = await downloadAndOptimizeImages(capture.images || []);
        capture.images = images.map(({ position, kind, originalUrl }) => ({ position, kind, originalUrl }));
        const queueId = enqueueCapture({
          jobId: this._jobKey,
          provider: this._providerId,
          sourceHash: listing.id,
          capture,
          images,
        });
        if (queueId) queued.push({ queueId, listing });
      } catch (error) {
        logger.warn(
          `Complete detail capture failed for '${listing.title}' (Provider: '${this._providerId}'); it will be rediscovered.`,
          error,
        );
      }
    }
    if (queued.length === 0) throw new NoNewListingsWarning();
    logger.info(`Queued ${queued.length} complete captures for '${this._providerId}'.`);
    return queued;
  }

  /**
   * Fetch listings from the provider, using the default Extractor flow unless
   * a provider-specific getListings override is supplied.
   *
   * @param {string} url The provider URL to fetch from.
   * @returns {Promise<ParsedListing[]>} Resolves with an array of listings (empty when none found).
   */
  async _getListings(url) {
    const extractor = new Extractor({ ...this._providerConfig.puppeteerOptions, browser: this._browser });
    await extractor.execute(url, this._providerConfig.waitForSelector, this._providerId);
    const listings = extractor.parseResponseText(
      this._providerConfig.crawlContainer,
      this._providerConfig.crawlFields,
      url,
    );
    return listings == null ? [] : listings;
  }

  /**
   * Normalize raw listings into the provider-specific ParsedListing shape.
   *
   * @param {any[]} listings Raw listing entries from the extractor or override.
   * @returns {ParsedListing[]} Normalized listings.
   */
  _normalize(listings) {
    return listings.map((listing) => this._providerConfig.normalize(listing));
  }

  /**
   * Filter out listings that are missing required fields and those rejected by the
   * provider's blacklist/filter function.
   *
   * @param {ParsedListing[]} listings Listings to filter.
   * @returns {ParsedListing[]} Filtered listings that pass validation and provider filter.
   */
  _filter(listings) {
    const requiredKeys = this._providerConfig.requiredFieldNames;
    const requireValues = ['id', 'link', 'title'];

    return (
      listings
        // this should never filter some listings out, because the normalize function should always extract all fields.
        .filter((item) => requiredKeys.every((key) => key in item))
        // Drop listings missing a required identifying field *before* the provider
        // filter runs, so provider filter functions never have to defend against a
        // null id/link/title.
        .filter((item) => requireValues.every((key) => item[key] != null))
        .filter(this._providerConfig.filter)
    );
  }

  /**
   * Determine which listings are new by comparing their IDs against stored hashes.
   *
   * @param {ParsedListing[]} listings Listings to evaluate for novelty.
   * @returns {ParsedListing[]} New listings not seen before.
   * @throws {NoNewListingsWarning} When no new listings are found.
   */
  _findNew(listings) {
    logger.debug(`Checking ${listings.length} listings for new entries (Provider: '${this._providerId}')`);
    const newListings = listings.filter((o) => !isKnownSource(this._jobKey, this._providerId, o.id));
    if (newListings.length === 0) {
      throw new NoNewListingsWarning();
    }
    return newListings;
  }

  /**
   * Handle errors occurring in the pipeline, logging levels depending on type.
   *
   * @param {Error} err Error instance thrown by previous steps.
   * @returns {void}
   */
  _handleError(err) {
    if (err.name === 'NoNewListingsWarning') {
      logger.debug(`No new listings found (Provider: '${this._providerId}').`);
    } else if (err instanceof GeocodingUnavailableError) {
      logger.error(`Run aborted, nothing stored: ${err.message}`);
    } else {
      logger.error(err);
    }
  }
}

export default FredyPipelineExecutioner;
