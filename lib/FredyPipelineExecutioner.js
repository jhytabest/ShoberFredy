/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { NoNewListingsWarning, GeocodingUnavailableError } from './errors.js';
import {
  getKnownListingHashesForJobAndProvider,
  storeListings,
  updateListingDistance,
} from './services/storage/listingsStorage.js';
import { getJob } from './services/storage/jobStorage.js';
import { sendToUser } from './services/sse/sse-broker.js';
import * as notify from './notification/notify.js';
import Extractor from './services/extractor/extractor.js';
import urlModifier from './services/queryStringMutator.js';
import logger from './services/logger.js';
import { geocodeAddress } from './services/geocoding/geoCodingService.js';
import { distanceMeters } from './services/listings/distanceCalculator.js';
import { getSettings, getUserSettings } from './services/storage/settingsStorage.js';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { formatListing } from './utils/formatListing.js';
import { isOneOf } from './utils.js';
import { dropDuplicates } from './services/listings/dedupe.js';
import { scoreListingNow } from './services/scoring/marketScore.js';
import { parseListingAttrs } from './services/scoring/listingAttrs.js';
import { textFeatureFlags } from './services/scoring/hedonicFeatures.js';

/** @import { ParsedListing } from './types/listing.js' */
/** @import { Job } from './types/job.js' */
/** @import { ProviderConfig } from './types/providerConfig.js' */
/** @import { SpecFilter, SpatialFilter } from './types/filter.js' */
/** @import { SimilarityCache } from './types/similarityCache.js' */
/** @import { Browser } from './types/browser.js' */

/**
 * Runtime orchestrator for fetching, normalizing, filtering, deduplicating, storing,
 * and notifying about new listings from a configured provider.
 *
 * Storage policy: EVERY non-duplicate listing is stored. The job's filters
 * (blacklist, specs, spatial) decide VISIBILITY only — a failing listing is
 * stored hidden with the failure recorded in hidden_reason. Only visible
 * listings are notified.
 *
 * The execution flow is:
 * 1) Prepare provider URL (sorting, etc.)
 * 2) Extract raw listings from the provider
 * 3) Normalize listings to the provider schema
 * 4) Drop structurally broken rows (missing required/identifying fields)
 * 5) Identify new listings (vs. previously stored hashes)
 * 6) Optionally enrich new listings via provider.fetchDetails
 * 7) Geocode (Google, cached)
 * 8) Extract structured attributes and pre-compute the market score
 * 9) Drop duplicates (similarity cache + cross-portal database check)
 * 10) Evaluate the job's filters into a visibility verdict (hidden_reason)
 * 11) Persist listings + attributes + scores in one transaction
 * 12) Calculate distance to the user's home address
 * 13) Broadcast the live-reload event
 * 14) Notify about the visible listings (score line rendered by notify)
 */
class FredyPipelineExecutioner {
  /**
   * Create a new runtime instance for a single provider/job execution.
   *
   * @param {ProviderConfig} providerConfig Provider configuration.
   * @param {Job} job Job configuration.
   * @param {string} providerId The ID of the provider currently in use.
   * @param {SimilarityCache} similarityCache Cache instance for checking similar entries.
   * @param {Browser} browser Puppeteer browser instance.
   */
  constructor(providerConfig, job, providerId, similarityCache, browser) {
    /** @type {ProviderConfig} */
    this._providerConfig = providerConfig;
    /** @type {Object} */
    this._jobNotificationConfig = job.notificationAdapter;
    /** @type {string} */
    this._jobKey = job.id;
    /** @type {SpecFilter | null} */
    this._jobSpecFilter = job.specFilter;
    /** @type {SpatialFilter | null} */
    this._jobSpatialFilter = job.spatialFilter;
    /** @type {string[]} */
    this._jobBlacklist = Array.isArray(job.blacklist) ? job.blacklist : [];
    /** @type {string} */
    this._providerId = providerId;
    /** @type {SimilarityCache} */
    this._similarityCache = similarityCache;
    /** @type {Browser} */
    this._browser = browser;
  }

  /**
   * Execute the end-to-end pipeline for a single provider run.
   *
   * @returns {Promise<ParsedListing[]|void>} Resolves to the list of new (and similarity-filtered) listings
   * after notifications have been sent; resolves to void when there are no new listings.
   */
  execute() {
    return Promise.resolve(urlModifier(this._providerConfig.url, this._providerConfig.sortByDateParam))
      .then(this._providerConfig.getListings?.bind(this) ?? this._getListings.bind(this))
      .then(this._normalize.bind(this))
      .then(this._filter.bind(this))
      .then(this._findNew.bind(this))
      .then(this._fetchDetails.bind(this))
      .then(this._geocode.bind(this))
      .then(this._enrich.bind(this))
      .then(this._dedupe.bind(this))
      .then(this._evaluateVisibility.bind(this))
      .then(this._save.bind(this))
      .then(this._calculateDistance.bind(this))
      .then(this._sendNewListingsToUser.bind(this))
      .then(this._notify.bind(this))
      .catch(this._handleError.bind(this));
  }

  /**
   * Optionally, enrich new listings with data from their detail pages.
   * Only called when the provider config defines a `fetchDetails` function.
   * Fetches are performed sequentially to avoid overloading the provider or
   * the shared browser instance.
   *
   * @param {Listing[]} newListings New listings to enrich.
   * @returns {Promise<Listing[]>} Resolves with enriched listings.
   */
  async _fetchDetails(newListings) {
    if (typeof this._providerConfig.fetchDetails !== 'function') {
      return newListings;
    }
    const userId = getJob(this._jobKey)?.userId;
    const enabledProviders = getUserSettings(userId)?.provider_details ?? [];
    if (!userId || !Array.isArray(enabledProviders) || !enabledProviders.includes(this._providerId)) {
      return newListings;
    }
    const listingsToEnrich = process.env.NODE_ENV === 'test' ? newListings.slice(0, 1) : newListings;
    const enriched = [];
    for (const listing of listingsToEnrich) {
      const beforeAddress = listing.address;
      const beforeDescription = listing.description;
      try {
        const detailed = await this._providerConfig.fetchDetails(listing, this._browser);
        const changedAddress = detailed?.address !== beforeAddress;
        const changedDescription = detailed?.description !== beforeDescription;
        logger.debug(
          `Detail scrape succeeded for '${listing.title}' (Provider: '${this._providerId}', addressChanged: ${changedAddress}, descriptionChanged: ${changedDescription})`,
        );
        if (detailed && changedDescription) {
          // Preserve the search-result snippet: the blacklist evaluates
          // against it unless the user opted in to detail-page matching
          // via blacklist_filter_on_provider_details (detail descriptions
          // carry boilerplate that false-positives blacklist terms).
          detailed.description_snippet = beforeDescription;
        }
        enriched.push(detailed);
      } catch (error) {
        // A single broken detail page must not abort the whole batch; keep
        // the search-result version of the listing and move on.
        logger.warn(
          `Detail scrape failed for '${listing.title}' (Provider: '${this._providerId}', url: ${listing.link})`,
          error,
        );
        enriched.push({ ...listing, detail_scrape_failed: true });
      }
    }
    return enriched;
  }

  /**
   * Geocode new listings.
   *
   * @param {ParsedListing[]} newListings New listings to geocode.
   * @returns {Promise<ParsedListing[]>} Resolves with the listings (potentially with added coordinates).
   */
  async _geocode(newListings) {
    for (const listing of newListings) {
      if (listing.address) {
        const coords = await geocodeAddress(listing.address);
        if (coords == null) {
          // The geocoding service returns null only when the geocoder itself
          // is unavailable (no key, quota, transport). Abort the run before
          // save: nothing half-geocoded is stored, the listings come back on
          // the next run, and the metrics exporter flags the health error.
          throw new GeocodingUnavailableError(
            `Geocoder unavailable while processing '${listing.title}' (Provider: '${this._providerId}')`,
          );
        }
        if (coords.lat !== -1 && coords.lng !== -1) {
          listing.latitude = coords.lat;
          listing.longitude = coords.lng;
        }
      }
    }
    return newListings;
  }

  /**
   * Attach structured attributes (parsed from the listing text) and the
   * pre-save market score to each listing. Both are persisted by _save in
   * the same transaction as the listing row. Fails open per listing.
   *
   * @param {ParsedListing[]} newListings
   * @returns {ParsedListing[]} The same listings, enriched in place.
   */
  _enrich(newListings) {
    for (const listing of newListings) {
      try {
        const attrs = parseListingAttrs({ ...listing, provider: this._providerId });
        attrs.features = textFeatureFlags(listing.title, listing.description, listing.address);
        listing.attributes = attrs;
        listing.marketScore = scoreListingNow(listing, attrs);
      } catch (error) {
        logger.warn(`attribute/score enrichment failed for '${listing.title}'; storing unenriched`, error);
      }
    }
    return newListings;
  }

  /**
   * Drop duplicates before save: entries similar to already seen ones
   * (similarity cache) and flats already covered by a visible listing on
   * another portal/job (cross-portal database check). Duplicates are never
   * stored.
   *
   * @param {ParsedListing[]} newListings
   * @returns {ParsedListing[]} Listings that are not duplicates.
   * @throws {NoNewListingsWarning} When every listing was a duplicate.
   */
  _dedupe(newListings) {
    const kept = dropDuplicates(newListings, {
      similarityCache: this._similarityCache,
      providerId: this._providerId,
    });
    if (kept.length === 0) {
      throw new NoNewListingsWarning();
    }
    return kept;
  }

  /**
   * Evaluate the job's filters into a visibility verdict. Nothing is dropped:
   * a failing listing gets its hidden_reason set and is stored hidden by
   * _save. Checked in order: blacklist (title/description, token-aware),
   * specs (minRooms/minSize/maxPrice), spatial filter (missing coordinates or
   * outside every polygon). Geocoder unavailability aborts the provider batch
   * before this step.
   *
   * @param {ParsedListing[]} newListings
   * @returns {ParsedListing[]} The same listings with hidden_reason set where applicable.
   */
  _evaluateVisibility(newListings) {
    const userId = getJob(this._jobKey)?.userId;
    const blacklistOnDetails = getUserSettings(userId)?.blacklist_filter_on_provider_details === true;
    for (const listing of newListings) {
      listing.hidden_reason = this._visibilityVerdict(listing, blacklistOnDetails);
      if (listing.hidden_reason) {
        logger.debug(
          `Storing listing hidden (${listing.hidden_reason}): '${listing.title}' (Provider: '${this._providerId}')`,
        );
      }
    }
    return newListings;
  }

  /**
   * @param {ParsedListing} listing
   * @param {boolean} blacklistOnDetails Whether the blacklist also matches the
   *   enriched detail-page description (user setting
   *   blacklist_filter_on_provider_details); otherwise only the title and the
   *   search-result snippet are evaluated.
   * @returns {string|null} hidden_reason, or null when the listing is visible.
   */
  _visibilityVerdict(listing, blacklistOnDetails) {
    const description =
      blacklistOnDetails || listing.description_snippet == null ? listing.description : listing.description_snippet;
    if (isOneOf(listing.title, this._jobBlacklist) || isOneOf(description, this._jobBlacklist)) {
      return 'blacklist';
    }

    const { minRooms, minSize, maxPrice } = this._jobSpecFilter || {};
    if (
      (minRooms && listing.rooms != null && listing.rooms < minRooms) ||
      (minSize && listing.size != null && listing.size < minSize) ||
      (maxPrice && listing.price != null && listing.price > maxPrice)
    ) {
      return 'spec_filter';
    }

    const polygonFeatures = this._jobSpatialFilter?.features?.filter((f) => f.geometry?.type === 'Polygon');
    if (polygonFeatures?.length) {
      const latitude = Number(listing.latitude);
      const longitude = Number(listing.longitude);
      const hasValidCoordinates =
        Number.isFinite(latitude) && Number.isFinite(longitude) && latitude !== -1 && longitude !== -1;

      if (!hasValidCoordinates) {
        // Geocoder unavailability aborts the run in _geocode, so reaching
        // this point means the address is definitively not resolvable.
        return 'no_coordinates';
      }

      const point = [longitude, latitude]; // GeoJSON format: [lon, lat]
      if (!polygonFeatures.some((feature) => booleanPointInPolygon(point, feature))) {
        return 'area_filter';
      }
    }

    return null;
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
        // TODO: move blacklist filter to this file, so it will handle for all providers in same way.
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
    const knownHashes = new Set(getKnownListingHashesForJobAndProvider(this._jobKey, this._providerId) || []);

    const newListings = listings.filter((o) => !knownHashes.has(o.id));
    if (newListings.length === 0) {
      throw new NoNewListingsWarning();
    }
    return newListings;
  }

  /**
   * Send notifications for new listings using the configured notification adapter(s).
   *
   * @param {ParsedListing[]} newListings New listings to notify about.
   * @returns {Promise<ParsedListing[]>} Resolves to the provided listings after notifications complete.
   * @throws {NoNewListingsWarning} When there are no listings to notify about.
   */
  async _notify(newListings) {
    // Hidden listings are stored for the market corpus; only visible ones
    // reach the user.
    const visibleListings = newListings.filter((listing) => !listing.hidden_reason);
    if (visibleListings.length === 0) {
      throw new NoNewListingsWarning();
    }
    const formattedListings = visibleListings.map(formatListing);
    const settings = await getSettings();
    const baseUrl = settings?.baseUrl ?? '';
    const sendNotifications = notify.send(
      this._providerId,
      formattedListings,
      this._jobNotificationConfig,
      this._jobKey,
      baseUrl,
    );
    return Promise.all(sendNotifications).then(() => visibleListings);
  }

  /**
   * Persist new listings and pass them through.
   *
   * @param {ParsedListing[]} newListings Listings to store.
   * @returns {ParsedListing[]} The same listings, unchanged.
   */
  _save(newListings) {
    logger.debug(`Storing ${newListings.length} new listings (Provider: '${this._providerId}')`);
    storeListings(this._jobKey, this._providerId, newListings);
    return newListings;
  }

  /**
   * Broadcast real-time live reload event to user via SSE broker.
   *
   * @param {ParsedListing[]} newListings New listings to broadcast.
   * @returns {ParsedListing[]} The same listings, unchanged.
   */
  _sendNewListingsToUser(newListings) {
    if (newListings.length > 0) {
      try {
        const job = getJob(this._jobKey);
        const userId = job?.userId;
        if (userId) {
          sendToUser(userId, 'listings:new', { jobId: this._jobKey, count: newListings.length });
        }
      } catch (err) {
        logger.error('Error broadcasting listings:new event', err);
      }
    }
    return newListings;
  }

  /**
   * Calculate distance for new listings.
   *
   * @param {ParsedListing[]} listings
   * @returns {ParsedListing[]}
   * @private
   */
  _calculateDistance(listings) {
    if (listings.length === 0) return [];

    const job = getJob(this._jobKey);
    const userId = job?.userId;

    if (userId == null || typeof userId !== 'string') {
      logger.debug('Skipping distance calculation: userId is missing or invalid');
      return listings;
    }

    const userSettings = getUserSettings(userId);
    const homeAddress = userSettings?.home_address;

    if (!homeAddress || !homeAddress.coords) {
      return listings;
    }

    const { lat, lng } = homeAddress.coords;
    for (const listing of listings) {
      if (listing.latitude != null && listing.longitude != null) {
        const dist = distanceMeters(lat, lng, listing.latitude, listing.longitude);
        updateListingDistance(listing.id, dist);
        listing.distance_to_destination = dist;
      }
    }
    return listings;
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
