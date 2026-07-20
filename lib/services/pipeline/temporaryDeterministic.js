/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';
import { isOneOf } from '../../utils.js';

/**
 * Deliberately small pre-LLM classifier. Its output is used only for queue
 * dedupe, blacklist routing, and audit. No value produced here may replace an
 * LLM field after the LLM has run.
 */
export function discoveryDedupeKeys(listing) {
  const keys = [];
  const link = canonicalUrl(listing?.link);
  if (link) keys.push(`url:${link}`);
  return unique(keys);
}

export function detailDedupeKeys({ discovery, images = [] }) {
  const keys = discoveryDedupeKeys(discovery);

  const card = strictCardIdentity(discovery);
  if (card) {
    for (const image of images) {
      if (image?.contentHash) keys.push(`card-image:${card}:${image.contentHash}`);
    }
  }
  return unique(keys);
}

export function preLlmBlacklistReason(capture, discovery, blacklist) {
  if (!Array.isArray(blacklist) || blacklist.length === 0) return null;
  const cardText = [discovery?.title, discovery?.description].filter(Boolean).join('\n');
  if (isOneOf(blacklistEvidenceText(capture?.fullText), blacklist) || isOneOf(cardText, blacklist)) {
    return 'blacklist_pre_llm';
  }
  return null;
}

export function blacklistEvidenceText(value) {
  // Portal branding is chrome, not a statement that the property is a WG.
  return String(value || '').replace(/\bWG-Gesucht(?:\.de)?\b/giu, '');
}

export function canonicalUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    if (/^(?:www\.)?wg-gesucht\.de$/iu.test(url.hostname) && url.searchParams.has('asset_id')) {
      const assetId = url.searchParams.get('asset_id');
      url.search = '';
      url.searchParams.set('asset_id', assetId);
      return url.toString().replace(/\/$/, '');
    }
    // Listing identity sometimes lives in the query string (notably WG's
    // asset_id). Remove only known tracking parameters.
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|ref|referrer|tracking|trackingId)$/iu.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(value).trim();
  }
}

function strictCardIdentity(discovery) {
  const address = normalizeText(discovery?.address);
  const price = finitePositive(discovery?.price);
  const size = finitePositive(discovery?.size);
  const rooms = finitePositive(discovery?.rooms);
  if (!address || !/\d/.test(address) || price == null || size == null || rooms == null) return null;
  return sha256(`${address}|${price}|${size}|${rooms}`);
}

function finitePositive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('de-DE')
    .replace(/\s+/g, ' ')
    .trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
