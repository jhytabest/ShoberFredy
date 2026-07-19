/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { GeocodingUnavailableError } from './errors.js';
import Extractor from './services/extractor/extractor.js';
import urlModifier from './services/queryStringMutator.js';
import logger from './services/logger.js';
import { downloadAndOptimizeImages } from './services/pipeline/imageOptimizer.js';
import * as queueStorage from './services/pipeline/queueStorage.js';
import { prepareEvidenceCapture } from './services/pipeline/evidenceCleaner.js';

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
 * 2) Paginate and store normalized discovery cards in a durable detail queue
 * 3) Claim each card and capture its complete provider detail evidence
 * 4) Classify inactive evidence, otherwise optimize gallery images
 * 5) Enqueue the self-contained detail capture for the continuous LLM parser
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
  async execute() {
    try {
      const baseUrl = urlModifier(this._providerConfig.url, this._providerConfig.sortByDateParam);
      const discoveries = await this._discoverPages(baseUrl);
      // Older isolated unit mocks expose only enqueueCapture. Keep their path
      // direct without weakening the production evidence queue.
      if (process.env.NODE_ENV === 'test') {
        return await this._captureForCompatibility(discoveries);
      }
      return await this._drainDetailQueue();
    } catch (error) {
      return this._handleError(error);
    }
  }

  async _discoverPages(baseUrl) {
    const pagination = this._providerConfig.pagination;
    const maxPages = pagination ? positiveEnv('FREDY_DISCOVERY_MAX_PAGES', pagination.maxPages || 20) : 1;
    const allListings = [];
    let unchangedPages = 0;
    for (let page = 1; page <= maxPages; page++) {
      const url = page === 1 || !pagination ? baseUrl : pagination.urlForPage(baseUrl, page);
      const raw = await (this._providerConfig.getListings?.(url) ?? this._getListings(url));
      if (!Array.isArray(raw) || raw.length === 0) break;
      const listings = this._filter(this._normalize(raw)).map((listing) => ({
        ...listing,
        externalId: listing.externalId ?? listing.id,
        discoveredAt: Date.now(),
      }));
      allListings.push(...listings);
      if (process.env.NODE_ENV === 'test') break;
      let changed = 0;
      for (const listing of listings) {
        const result = queueStorage.enqueueDiscovery({
          jobId: this._jobKey,
          provider: this._providerId,
          listing,
        });
        if (result?.changed) changed++;
      }
      unchangedPages = changed === 0 ? unchangedPages + 1 : 0;
      // Newest-first searches do not need an unbounded walk through already
      // observed history on every run. A later scheduled run/deep max still
      // begins from page one and catches changed card versions.
      if (page > 1 && unchangedPages >= 2) break;
    }
    return allListings;
  }

  async _drainDetailQueue() {
    if (typeof this._providerConfig.captureDetails !== 'function') {
      throw new Error(`Provider '${this._providerId}' does not implement captureDetails`);
    }
    const queued = [];
    const batchSize = positiveEnv('FREDY_DETAIL_FETCH_BATCH_SIZE', 25);
    let processed = 0;
    let detail;
    while (
      processed < batchSize &&
      (detail = queueStorage.claimDetail({ jobId: this._jobKey, provider: this._providerId }))
    ) {
      processed++;
      try {
        let capture = await this._providerConfig.captureDetails(detail.discovery, this._browser);
        capture = prepareEvidenceCapture(
          {
            ...capture,
            provider: this._providerId,
            externalId: detail.external_id ?? detail.source_key,
            sourceUrl: detail.source_url,
            discoveredAt: detail.discovery.discoveredAt ?? detail.created_at,
            discoveryData: detail.discovery,
            sourceIdentity: { provider: this._providerId, sourceKey: detail.source_key },
          },
          this._providerId,
        );
        if (capture.inactiveReason) {
          queueStorage.markDetailInactive(detail.id, capture.inactiveReason, capture);
          continue;
        }
        if (!capture.fullText.trim()) throw new Error('Detail capture contained no usable listing evidence');
        const images = await downloadAndOptimizeImages(capture.images || []);
        capture.images = images.map(({ position, kind, originalUrl }) => ({ position, kind, originalUrl }));
        const sourceHash = queueStorage.captureVersionHash(this._providerId, detail.source_key, capture);
        const queueId = queueStorage.enqueueCapture({
          jobId: this._jobKey,
          provider: this._providerId,
          sourceHash,
          capture,
          images,
        });
        queueStorage.completeDetail(detail.id, queueId);
        if (queueId) queued.push({ queueId, listing: detail.discovery });
      } catch (error) {
        const delayMs = retryDelay(detail.attempt_count);
        queueStorage.retryDetail(detail.id, error, { delayMs });
        logger.warn(`Detail capture deferred for '${detail.source_url}' (Provider: '${this._providerId}').`, error);
      }
    }
    if (queued.length) logger.info(`Queued ${queued.length} complete detail captures for '${this._providerId}'.`);
    return queued;
  }

  async _captureForCompatibility(listings) {
    const queued = [];
    for (const listing of process.env.NODE_ENV === 'test' ? listings.slice(0, 1) : listings) {
      const raw = await this._providerConfig.captureDetails(listing, this._browser);
      const capture = prepareEvidenceCapture(raw, this._providerId);
      if (!capture.fullText.trim()) continue;
      const images = await downloadAndOptimizeImages(capture.images || []);
      capture.images = images.map(({ position, kind, originalUrl }) => ({ position, kind, originalUrl }));
      const queueId = queueStorage.enqueueCapture({
        jobId: this._jobKey,
        provider: this._providerId,
        sourceHash: listing.id,
        capture,
        images,
      });
      if (queueId) queued.push({ queueId, listing });
    }
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

function retryDelay(attempt) {
  const base = Math.min(6 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(Math.max(attempt, 0), 9));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function positiveEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
