/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import { providerErrorForResponse, ProviderTransientError } from '../pipeline/providerErrors.js';
import { isochroneToPolylines } from './immowelt-search-model.js';

export const IMMOWELT_ORIGIN = 'https://www.immowelt.de';

const WARMUP_NAVIGATION_TIMEOUT = 60_000;

const DATADOME_COOKIE_TIMEOUT = 15_000;

const REQUEST_TIMEOUT = 45_000;

const CLASSIFIED_LIST_BATCH_SIZE = 30;

const warmPages = new WeakMap();

async function acquireWarmPage(browser) {
  const existing = warmPages.get(browser);
  if (existing != null) {
    try {
      const page = await existing;
      if (!page.isClosed()) return page;
    } catch {
      // A refused session can be replaced.
    }
    warmPages.delete(browser);
  }

  const pending = (async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${IMMOWELT_ORIGIN}/`, {
        waitUntil: 'domcontentloaded',
        timeout: WARMUP_NAVIGATION_TIMEOUT,
      });
      await page
        .waitForFunction(() => /(^|;\s*)datadome=/.test(globalThis.document.cookie), {
          timeout: DATADOME_COOKIE_TIMEOUT,
        })
        .catch(() => logger.debug('Immowelt did not hand out a datadome cookie; continuing without it.'));
      return page;
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
  })();

  warmPages.set(browser, pending);

  try {
    return await pending;
  } catch (error) {
    warmPages.delete(browser);
    throw error;
  }
}

export async function releaseSession(browser) {
  const pending = warmPages.get(browser);
  if (pending == null) return;
  warmPages.delete(browser);
  try {
    const page = await pending;
    if (!page.isClosed()) await page.close();
  } catch {
    // The browser may already have closed the page.
  }
}

async function reportFailure(status, step, body) {
  throw providerErrorForResponse({ status }, { message: `Immowelt ${step} answered ${status}: ${body}` });
}

async function resolveCommuteAreas(browser, commutes) {
  const page = await acquireWarmPage(browser);

  const result = await page.evaluate(
    async (targets, timeout) => {
      const withTimeout = (promise) =>
        Promise.race([
          promise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('immowelt routing request timed out')), timeout),
          ),
        ]);

      const read = async (step, url) => {
        const response = await withTimeout(fetch(url));
        const body = await response.text();
        if (response.status !== 200) {
          return { error: { step, status: response.status, body: body.slice(0, 400) } };
        }
        try {
          return { data: JSON.parse(body) };
        } catch {
          return { error: { step, status: response.status, body: body.slice(0, 400) } };
        }
      };

      try {
        const isochrones = [];

        for (const commute of targets) {
          const place = await read(
            `place lookup for '${commute.placeId}'`,
            `/search-mfe-bff/places/data?placesIds%5B%5D=${encodeURIComponent(commute.placeId)}&parentTypes%5B%5D=AD08`,
          );
          if (place.error != null) return { error: place.error };

          const coordinates = place.data?.places?.[0]?.coordinates;
          if (!Number.isFinite(coordinates?.lat) || !Number.isFinite(coordinates?.lng)) {
            return {
              error: {
                step: `place lookup for '${commute.placeId}'`,
                status: 200,
                body: 'the place has no coordinates to travel from',
              },
            };
          }

          const area = await read(
            `routing around '${commute.placeId}'`,
            `/search-mfe-bff/routing/isochrone?id=${encodeURIComponent(commute.placeId)}&lat=${coordinates.lat}` +
              `&lng=${coordinates.lng}&commuteMode=${encodeURIComponent(commute.mode)}` +
              `&commuteDuration=${encodeURIComponent(commute.duration)}`,
          );
          if (area.error != null) return { error: area.error };

          isochrones.push(area.data?.isochrone ?? []);
        }

        return { isochrones };
      } catch (error) {
        return { error: { step: 'routing request', status: 0, body: String(error?.message || error) } };
      }
    },
    commutes,
    REQUEST_TIMEOUT,
  );

  if (result.error != null) {
    await reportFailure(result.error.status, result.error.step, result.error.body);
  }

  const polylines = result.isochrones.flatMap((isochrone) => isochroneToPolylines(isochrone));

  if (polylines.length === 0) {
    throw new Error(
      `Immowelt's routing service answered with no reachable area for this job's commute time, so there is ` +
        `nothing to search in.`,
    );
  }

  return polylines;
}

export async function resolveSearchAreas(browser, { criteria, paging, commutes = [] }) {
  if (commutes.length === 0) return { criteria, paging };

  const polylines = await resolveCommuteAreas(browser, commutes);

  return {
    criteria: {
      ...criteria,
      location: { ...criteria.location, polylines: [...(criteria.location?.polylines ?? []), ...polylines] },
    },
    paging,
  };
}

export async function searchClassifieds(browser, request) {
  const payload = await resolveSearchAreas(browser, request);
  const page = await acquireWarmPage(browser);

  const result = await page.evaluate(
    async (payload, timeout, batchSize) => {
      const withTimeout = (promise) =>
        Promise.race([
          promise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('immowelt bff request timed out')), timeout)),
        ]);

      try {
        const searchResponse = await withTimeout(
          fetch('/serp-bff/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify(payload),
          }),
        );
        const searchBody = await searchResponse.text();
        if (searchResponse.status !== 200) {
          return { error: { step: 'search', status: searchResponse.status, body: searchBody.slice(0, 800) } };
        }

        const search = JSON.parse(searchBody);
        if (!Array.isArray(search.classifieds)) throw new Error('Search response has no classifieds array');
        const ids = search.classifieds.map((entry) => entry?.id).filter(Boolean);
        if (ids.length !== search.classifieds.length)
          throw new Error('Search response contains invalid classified IDs');
        if (ids.length === 0) return { classifieds: [] };

        const classifieds = [];
        let failure = null;

        for (let offset = 0; offset < ids.length; offset += batchSize) {
          const batch = ids.slice(offset, offset + batchSize);
          const listResponse = await withTimeout(
            fetch(`/classifiedList/${batch.join(',')}`, { headers: { 'x-language': 'de' } }),
          );
          const listBody = await listResponse.text();
          if (listResponse.status !== 200) {
            failure ??= { step: 'classifiedList', status: listResponse.status, body: listBody.slice(0, 800) };
            break;
          }
          classifieds.push(...JSON.parse(listBody));
        }

        return { classifieds, error: failure };
      } catch (error) {
        return { error: { step: 'request', status: 0, body: String(error?.message || error) } };
      }
    },
    payload,
    REQUEST_TIMEOUT,
    CLASSIFIED_LIST_BATCH_SIZE,
  );

  if (!result.error && !Array.isArray(result.classifieds))
    throw new ProviderTransientError('Invalid Immowelt card response');
  const classifieds = Array.isArray(result.classifieds) ? result.classifieds : [];

  if (result.error != null) {
    await reportFailure(result.error.status, result.error.step, result.error.body);
  }

  return classifieds;
}
