/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { GeocodingUnavailableError } from './errors.js';
import Extractor from './services/extractor/extractor.js';
import urlModifier from './services/queryStringMutator.js';
import logger from './services/logger.js';
import * as queueStorage from './services/pipeline/queueStorage.js';
import { env, envIsSet } from './shared/env.js';

/** @import { ParsedListing } from './types/listing.js' */
/** @import { Job } from './types/job.js' */
/** @import { ProviderConfig } from './types/providerConfig.js' */
/** @import { Browser } from './types/browser.js' */

/**
 * Runtime producer for discovering listing cards from a configured provider.
 * Detail capture, parsing, filtering, persistence, rating, and notification
 * are handled by independent continuous workers after this producer returns.
 *
 * The execution flow is:
 * 1) Prepare provider URL (sorting, etc.)
 * 2) Paginate and store normalized discovery cards in a durable detail queue
 * 3) Return; the continuous detail worker owns every downstream action
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
      return await this._discoverPages(baseUrl);
    } catch (error) {
      return this._handleError(error);
    }
  }

  async _discoverPages(baseUrl) {
    const pagination = this._providerConfig.pagination;
    // FREDY_DISCOVERY_MAX_PAGES is an operator override, not the normal ceiling:
    // each provider states its own (much lower) page budget, so an unset knob has
    // to keep that rather than fall back to the registry-wide default.
    const providerMaxPages = pagination ? pagination.maxPages || 20 : 1;
    const maxPages =
      pagination && envIsSet('FREDY_DISCOVERY_MAX_PAGES') ? env('FREDY_DISCOVERY_MAX_PAGES') : providerMaxPages;
    const allListings = [];
    let unchangedPages = 0;
    for (let page = 1; page <= maxPages; page++) {
      const url = page === 1 || !pagination ? baseUrl : pagination.urlForPage(baseUrl, page);
      // The first page is allowed to throw: a provider refusing it is a fact
      // about the provider, and provider health needs the classified error
      // rather than an empty array. A later page failing is not worth losing the
      // pages that already succeeded over.
      let raw;
      try {
        raw = await (this._providerConfig.getListings?.(url) ?? this._getListings(url));
      } catch (error) {
        if (page === 1) throw error;
        logger.warn(`Discovery for '${this._providerId}' failed on page ${page}; keeping the earlier pages.`, error);
        break;
      }
      if (!Array.isArray(raw) || raw.length === 0) {
        // A first page without a single card is never normal: the provider
        // markup changed, or the response was a challenge/empty shell. Say so,
        // otherwise the provider goes quiet and looks merely idle.
        if (page === 1) {
          logger.warn(
            `No listings discovered for '${this._providerId}' on the first page. ` +
              `Check the provider's crawlContainer/crawlFields against the live markup. Url: ${url}`,
          );
        }
        break;
      }
      const listings = this._filter(this._normalize(raw)).map((listing) => ({
        ...listing,
        externalId: listing.externalId ?? listing.id,
        discoveredAt: Date.now(),
      }));
      if (listings.length === 0) {
        logger.warn(
          `Discovered ${raw.length} card(s) for '${this._providerId}' but none survived normalization ` +
            `(missing id/link). Url: ${url}`,
        );
      }
      allListings.push(...listings);
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

  /**
   * Fetch listings from the provider, using the default Extractor flow unless
   * a provider-specific getListings override is supplied.
   *
   * @param {string} url The provider URL to fetch from.
   * @returns {Promise<ParsedListing[]>} Resolves with an array of listings (empty when none found).
   */
  async _getListings(url) {
    const extractor = new Extractor({ ...this._providerConfig.puppeteerOptions, browser: this._browser });
    await extractor.execute(url, this._providerConfig.waitForSelector, this._providerId, {
      crawlContainer: this._providerConfig.crawlContainer,
      crawlFields: this._providerConfig.crawlFields,
    });
    const listings = await extractor.parseResponseText(
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
   * Reject only cards without a stable source identity. Semantic fields may be
   * absent here because the detail page and LLM own all facts and filtering.
   *
   * @param {ParsedListing[]} listings Listings to filter.
   * @returns {ParsedListing[]} Cards with a usable provider identity.
   */
  _filter(listings) {
    const requiredKeys = this._providerConfig.requiredFieldNames;
    const requireValues = ['id', 'link'];

    return (
      listings
        // this should never filter some listings out, because the normalize function should always extract all fields.
        .filter((item) => requiredKeys.every((key) => key in item))
        // Drop listings missing a required identifying field *before* the provider
        // detail worker runs, so an incomplete card cannot create an untraceable
        // queue item. Missing title/price/size/rooms are explicitly allowed.
        .filter((item) => requireValues.every((key) => item[key] != null))
    );
  }

  /**
   * Handle errors occurring in the pipeline, logging levels depending on type.
   *
   * @param {Error} err Error instance thrown by previous steps.
   * @returns {void}
   */
  _handleError(err) {
    if (err instanceof GeocodingUnavailableError) {
      logger.error(`Run aborted, nothing stored: ${err.message}`);
    } else {
      logger.error(err);
    }
  }
}

export default FredyPipelineExecutioner;
