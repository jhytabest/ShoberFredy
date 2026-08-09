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

class FredyPipelineExecutioner {
  constructor(providerConfig, job, providerId, browser) {
    this._providerConfig = providerConfig;
    this._jobKey = job.id;
    this._jobMaxPages = job.provider?.find((entry) => entry.id === providerId)?.maxPages ?? null;
    this._providerId = providerId;
    this._browser = browser;
  }

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
    const providerMaxPages = pagination ? pagination.maxPages || 20 : 1;
    const envMaxPages = pagination && envIsSet('FREDY_DISCOVERY_MAX_PAGES') ? env('FREDY_DISCOVERY_MAX_PAGES') : null;
    const maxPages = (pagination && this._jobMaxPages) || envMaxPages || providerMaxPages;
    const allListings = [];
    let unchangedPages = 0;
    for (let page = 1; page <= maxPages; page++) {
      const url = page === 1 || !pagination ? baseUrl : pagination.urlForPage(baseUrl, page);
      let raw;
      let containerPresent;
      try {
        const discovered = await (this._providerConfig.getListings?.(url) ?? this._getListings(url));
        raw = Array.isArray(discovered) ? discovered : (discovered?.listings ?? []);
        containerPresent = Array.isArray(discovered) ? true : (discovered?.containerPresent ?? true);
      } catch (error) {
        if (page === 1) throw error;
        logger.warn(`Discovery for '${this._providerId}' failed on page ${page}; keeping the earlier pages.`, error);
        break;
      }
      if (raw.length === 0) {
        if (page === 1) {
          logger.warn(
            containerPresent
              ? `No listings discovered for '${this._providerId}' on the first page, but the results ` +
                  `container was present, so the search itself returned nothing. Url: ${url}`
              : `No listings discovered for '${this._providerId}' on the first page and the results ` +
                  `container is missing entirely: the provider served something other than a results ` +
                  `page (soft block or changed markup). Url: ${url}`,
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
      let dropped = 0;
      for (const listing of listings) {
        try {
          const result = queueStorage.enqueueDiscovery({
            jobId: this._jobKey,
            provider: this._providerId,
            listing,
          });
          if (result?.changed) changed++;
        } catch (error) {
          dropped++;
          logger.event(
            'discovery_card_dropped',
            'error',
            `Could not record a discovered card for '${this._providerId}'; skipping it.`,
            error,
          );
        }
      }
      if (dropped) {
        logger.warn(`Dropped ${dropped} of ${listings.length} discovered card(s) for '${this._providerId}'.`);
      }
      unchangedPages = changed === 0 ? unchangedPages + 1 : 0;
      if (page > 1 && unchangedPages >= 2) break;
    }
    return allListings;
  }

  async _getListings(url) {
    const extractor = new Extractor({ ...this._providerConfig.puppeteerOptions, browser: this._browser });
    await extractor.execute(url, this._providerConfig.waitForSelector, this._providerId, {
      crawlContainer: this._providerConfig.crawlContainer,
      crawlFields: this._providerConfig.crawlFields,
    });
    return extractor.parseResponseText(this._providerConfig.crawlContainer, this._providerConfig.crawlFields, url);
  }

  _normalize(listings) {
    return listings.map((listing) => this._providerConfig.normalize(listing));
  }

  _filter(listings) {
    const requiredKeys = this._providerConfig.requiredFieldNames;
    const requireValues = ['id', 'link'];

    return listings
      .filter((item) => requiredKeys.every((key) => key in item))
      .filter((item) => requireValues.every((key) => item[key] != null));
  }

  _handleError(err) {
    if (err instanceof GeocodingUnavailableError) {
      logger.error(`Run aborted, nothing stored: ${err.message}`);
    } else {
      logger.error(err);
    }
  }
}

export default FredyPipelineExecutioner;
