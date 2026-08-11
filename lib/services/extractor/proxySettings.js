/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import http from 'node:http';

import { env } from '../../shared/env.js';
import logger from '../logger.js';

const PROBE_HOST = 'api.ipify.org:443';
const PROBE_TIMEOUT_MS = 5000;
const PROBE_TTL_MS = 2 * 60 * 1000;
const DOWN_AFTER_MS = 3 * PROBE_TTL_MS;

let probeInFlight = null;
let lastCheckedAt = null;
let lastOkAt = 0;
let unreachableLogged = false;

export async function currentProxyUrl() {
  try {
    const proxyUrl = env('FREDY_PROXY_URL').trim();
    if (!proxyUrl) return '';

    if (!probeInFlight && (!lastCheckedAt || Date.now() - lastCheckedAt >= PROBE_TTL_MS)) {
      probeInFlight = probe(proxyUrl)
        .then((ok) => {
          lastCheckedAt = Date.now();
          if (ok) {
            lastOkAt = lastCheckedAt;
            unreachableLogged = false;
          }
        })
        .catch(() => {
          lastCheckedAt = Date.now();
        })
        .finally(() => {
          probeInFlight = null;
        });
    }

    if (probeInFlight) await probeInFlight;

    if (Date.now() - lastOkAt < DOWN_AFTER_MS) return proxyUrl;
    if (!unreachableLogged) {
      unreachableLogged = true;
      logger.warn('Configured proxy is unreachable; providers that require it will wait until it recovers.');
    }
    return '';
  } catch (error) {
    if (!unreachableLogged) {
      unreachableLogged = true;
      logger.warn(
        'Could not check the configured proxy; providers that require it will wait until it recovers.',
        error,
      );
    }
    return '';
  }
}

export function proxyHealth() {
  const configured = Boolean(env('FREDY_PROXY_URL').trim());
  const reachable = configured && Date.now() - lastOkAt < DOWN_AFTER_MS;
  return {
    configured,
    reachable,
    usable: configured && reachable,
    checkedAt: lastCheckedAt,
  };
}

export function proxyMissingFor(provider, proxyUrl) {
  return provider?.metaInformation?.requiresProxy === true && !proxyUrl;
}

function probe(proxyUrl) {
  return new Promise((resolve) => {
    const url = new URL(proxyUrl);
    if (url.protocol !== 'http:') {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const headers = {};
    if (url.username || url.password) {
      const username = decodeURIComponent(url.username);
      const password = decodeURIComponent(url.password);
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }
    const request = http.request({
      host: url.hostname,
      port: url.port || 80,
      method: 'CONNECT',
      path: PROBE_HOST,
      headers,
    });
    request.on('connect', (response, socket) => {
      socket.destroy();
      finish(response.statusCode === 200);
    });
    request.on('response', (response) => {
      response.destroy();
      finish(false);
    });
    request.on('error', () => finish(false));
    request.setTimeout(PROBE_TIMEOUT_MS, () => {
      request.destroy();
      finish(false);
    });
    request.end();
  });
}
