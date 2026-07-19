/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import fetch from 'node-fetch';
import { botDetected } from '../extractor/utils.js';

const userAgents = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
];

/**
 * Check a listing exactly once during the daily lifecycle pass.
 *
 * Rules:
 * - HTTP 200 => active unless the body is a bot challenge or contains an
 *   explicit provider lifecycle marker.
 * - HTTP 401/403/429 or a known challenge page => unknown/bot-blocked.
 * - Any other response or network error => inactive.
 *
 * @param {string} link listing detail URL
 * @param {Array<string|RegExp>} [inactiveMarkers] provider-specific inactive markers
 * @returns {Promise<number>} 1 if active, 0 if not active and -1 if detected as bot
 */
export default async function checkIfListingIsActive(link, inactiveMarkers = []) {
  try {
    const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
    const res = await fetch(link, {
      redirect: 'manual',
      headers: {
        'User-Agent': userAgent,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'max-age=0',
        'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        Referer: 'https://www.google.com/',
      },
    });

    if ([401, 403, 429].includes(res.status)) return -1;
    if (res.status !== 200) return 0;

    const html = await res.text();
    if (botDetected(html, res.status)) return -1;
    const inactive = inactiveMarkers.some((marker) =>
      marker instanceof RegExp ? marker.test(html) : html.includes(String(marker)),
    );
    return inactive ? 0 : 1;
  } catch {
    return 0;
  }
}
