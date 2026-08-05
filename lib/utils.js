/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { dirname } from 'node:path';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { DEFAULT_CONFIG } from './defaultConfig.js';
import fs from 'fs';
import logger from './services/logger.js';

const RE_GT = />/g;
const RE_WEBP = /\/format\/webp/gi;
const RE_EXT = /\.(jpe?g|png|gif)(\?.*)?$/i;
const HTTPS_PREFIX = 'https://';
const providersDirectoryPath = `${getDirName()}/provider`;

let cachedProvidersPromise = null;

export function getProviders() {
  if (!cachedProvidersPromise) {
    const providerFileNames = fs.readdirSync(providersDirectoryPath).filter((fileName) => fileName.endsWith('.js'));
    cachedProvidersPromise = Promise.all(
      providerFileNames.map((fileName) => import(pathToFileURL(path.join(providersDirectoryPath, fileName)).href)),
    );
  }
  return cachedProvidersPromise;
}

const toJson = (v) => (v == null ? null : JSON.stringify(v));

const fromJson = (txt, fallback) => {
  if (txt == null) return fallback;
  try {
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
};

function firstBlacklistMatch(word, arr) {
  if (!arr || arr.length === 0 || word == null) return null;

  const haystack = String(word).toLocaleLowerCase('de-DE');
  return arr.find((item) => matchesBlacklistTerm(haystack, item)) ?? null;
}

function matchesBlacklistTerm(haystack, item) {
  if (item == null) return false;

  const term = String(item).trim().toLocaleLowerCase('de-DE');
  if (!term) return false;

  if (term === 'wg') {
    return hasWgToken(haystack);
  }

  const rule = blacklistRule(term);
  return rule == null ? matchesPhrase(haystack, term) : matchesStem(haystack, rule);
}

const NEGATION_PARTICLES = new Set(['kein', 'keine', 'keinen', 'keinem', 'keiner', 'nicht', 'ohne']);

const NEGATING_PREFIX = /^(un|nicht)/u;

const NON_SWAP_COMPOUND = /austausch|getausch|zutausch|umtausch|vertausch/u;

const NON_TEMPORARY_COMPOUND = /contemporar/u;

const WG_SUITABILITY_COMPOUND = /\bwg[-\s]?(tauglich|geeignet|f(ä|ae)hig)\w*/giu;

function blacklistRule(term) {
  if (/^befristet/u.test(term)) return { stem: 'befristet', negatable: true };
  if (/m(ö|o)b|furnish/u.test(term)) return { stem: furnishingStem(term), negatable: true };
  if (term.includes('tausch')) return { stem: 'tausch', negatable: false, except: NON_SWAP_COMPOUND };
  if (/^(unter|zwischen)miete$/u.test(term)) return { stem: term.slice(0, -1), negatable: false };
  if (/^sublet/u.test(term)) return { stem: 'sublet', negatable: false };
  if (/^temporar/u.test(term)) return { stem: 'temporar', negatable: false, except: NON_TEMPORARY_COMPOUND };
  return null;
}

function matchesPhrase(haystack, term) {
  const words = term.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return false;
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped.join('[^\\p{L}\\p{N}]+')}(?![\\p{L}\\p{N}])`, 'u');
  return pattern.test(haystack);
}

function furnishingStem(term) {
  return term.replace(/^(voll|teil|partly)\s*/u, '').replace(/e[rns]?$/u, '');
}

function matchesStem(haystack, { stem, negatable, except }) {
  if (!stem) return false;

  const words = haystack.split(/[^\p{L}\p{N}]+/u);
  return words.some((word, index) => {
    if (!word.includes(stem)) return false;
    if (except != null && except.test(word)) return false;
    if (!negatable) return true;
    if (NEGATING_PREFIX.test(word)) return false;
    return !NEGATION_PARTICLES.has(words[index - 1]);
  });
}

function hasToken(haystack, token) {
  return haystack.split(/[^\p{L}\p{N}]+/u).includes(token);
}

function hasWgToken(haystack) {
  const text = haystack.replace(WG_SUITABILITY_COMPOUND, ' ');
  const hasWg = hasToken(text, 'wg');
  const hasSharedFlat = hasToken(text, 'wohngemeinschaft');
  if (!hasWg && !hasSharedFlat) return false;

  const negativePattern = /(^|[^\p{L}\p{N}])(kein|keine|keinen|nicht)\s+(wg|wohngemeinschaft)([^\p{L}\p{N}]|$)/iu;
  if (negativePattern.test(text)) return false;

  return true;
}

function nullOrEmpty(val) {
  return val == null || val.length === 0;
}

function timeStringToMs(timeString, now) {
  const d = new Date(now);
  const parts = timeString.split(':');
  d.setHours(parts[0]);
  d.setMinutes(parts[1]);
  d.setSeconds(0);
  return d.getTime();
}

function duringWorkingHoursOrNotSet(config, now) {
  const { workingHours } = config;
  if (workingHours == null || nullOrEmpty(workingHours.from) || nullOrEmpty(workingHours.to)) {
    return true;
  }
  const toDate = timeStringToMs(workingHours.to, now);
  const fromDate = timeStringToMs(workingHours.from, now);

  if (isNaN(toDate) || isNaN(fromDate)) {
    return true;
  }

  if (toDate >= fromDate) {
    return now >= fromDate && now <= toDate;
  }

  return now >= fromDate || now <= toDate;
}

function getDirName() {
  return dirname(fileURLToPath(import.meta.url));
}

function buildHash(...inputs) {
  if (inputs == null) {
    return null;
  }
  const cleaned = inputs.filter((i) => i != null && i.length > 0);
  if (cleaned.length === 0) {
    return null;
  }
  return createHash('sha256').update(cleaned.join(',')).digest('hex');
}

export async function checkIfConfigIsAccessible() {
  const path = new URL('../conf/config.json', import.meta.url);
  try {
    if (!fs.existsSync(path)) {
      return true;
    }
    fs.accessSync(path, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readConfigFromStorage() {
  return JSON.parse(await readFile(new URL('../conf/config.json', import.meta.url)));
}

export async function refreshConfig() {
  checkIfConfigExistsAndWriteIfNot();

  try {
    await readConfigFromStorage();
  } catch (error) {
    logger.info('Error reading config file.', error);
  }
}

const checkIfConfigExistsAndWriteIfNot = () => {
  if (!fs.existsSync(`${getDirName()}/../conf/config.json`)) {
    logger.info('Could not find config file. Will create one with default values now');
    fs.writeFileSync(`${getDirName()}/../conf/config.json`, JSON.stringify({ ...DEFAULT_CONFIG }));
  }
};

const normalizeImageUrl = (url) => {
  if (typeof url !== 'string' || url.length === 0) return null;

  let u = url.trim().replace(RE_GT, '');
  if (RE_WEBP.test(u)) u = u.replace(RE_WEBP, '/format/jpg');
  if (!u.startsWith(HTTPS_PREFIX)) return null;
  if (!RE_EXT.test(u)) {
    const jpgIdx = u.toLowerCase().lastIndexOf('.jpg');
    if (jpgIdx > -1) u = u.slice(0, jpgIdx + 4);
  }
  return u;
};

export {
  firstBlacklistMatch,
  normalizeImageUrl,
  nullOrEmpty,
  duringWorkingHoursOrNotSet,
  getDirName,
  buildHash,
  toJson,
  fromJson,
};
