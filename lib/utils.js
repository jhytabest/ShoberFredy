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
import fs, { readFileSync } from 'fs';
import logger from './services/logger.js';

const RE_GT = />/g;
const RE_WEBP = /\/format\/webp/gi;
const RE_EXT = /\.(jpe?g|png|gif)(\?.*)?$/i;
const HTTPS_PREFIX = 'https://';
const providersDirectoryPath = `${getDirName()}/provider`;

/**
 * Lazily load all provider modules from the provider directory.
 * Caches the resolved array to avoid re-importing on subsequent calls.
 *
 * @returns {Promise<any[]>} A list of loaded provider modules.
 */
let cachedProvidersPromise = null;

export function getProviders() {
  if (!cachedProvidersPromise) {
    /** @type {string[]} */
    const providerFileNames = fs.readdirSync(providersDirectoryPath).filter((fileName) => fileName.endsWith('.js'));
    cachedProvidersPromise = Promise.all(
      providerFileNames.map((fileName) => import(pathToFileURL(path.join(providersDirectoryPath, fileName)).href)),
    );
  }
  return cachedProvidersPromise;
}

/**
 * Safely stringify a value to JSON for storage.
 * - Returns null when the input is null or undefined.
 * - Uses JSON.stringify directly otherwise.
 *
 * @template T
 * @param {T} v - Any JSON-serializable value.
 * @returns {string|null} JSON string or null.
 */
const toJson = (v) => (v == null ? null : JSON.stringify(v));

/**
 * Safely parse JSON text coming from storage.
 * - Returns the provided fallback when input is null/undefined.
 * - Returns the fallback when parsing fails.
 *
 * @template T
 * @param {string|null|undefined} txt - JSON text from DB/storage.
 * @param {T} fallback - Value to return when txt is null/invalid.
 * @returns {T} Parsed value or fallback.
 */
const fromJson = (txt, fallback) => {
  if (txt == null) return fallback;
  try {
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
};

/**
 * Check if a word matches any of the blacklist terms in the given array.
 * Matching is case-insensitive (German locale). Portal names and multi-word
 * phrases stay plain substring matches; German terms whose meaning flips under
 * negation, or that hide inside unrelated compounds, are matched per word:
 * - 'wg' only matches as a standalone token ("WG-Zimmer" yes, "Wegweiser"
 *   no) and is ignored in negated phrases ("keine WG").
 * - furnishing terms ('möbliert', 'furnished', …) match inside compounds
 *   ("teilmöbliert") but never when negated ("unmöbliert", "nicht möbliert").
 * - 'befristet' matches its inflections ("befristeten") but not "unbefristet".
 * - 'Tausch' matches swap wording but not "Austausch"/"ausgetauscht".
 * - 'Untermiete'/'Zwischenmiete' also match "Untermietvertrag" and friends.
 * See {@link blacklistRule} for the classification.
 * @param {string} word
 * @param {string[]} arr
 * @returns {boolean}
 */
/**
 * Return the blacklist term that fired. Callers persist it so a rejection can
 * be explained — and so
 * an over-broad term shows up in the reason counts instead of hiding inside an
 * undifferentiated `blacklist_pre_llm` total.
 *
 * @param {string} word
 * @param {string[]} arr
 * @returns {string|null} the configured term as written, or null
 */
function firstBlacklistMatch(word, arr) {
  if (!arr || arr.length === 0 || word == null) return null;

  const haystack = String(word).toLocaleLowerCase('de-DE');
  return arr.find((item) => matchesBlacklistTerm(haystack, item)) ?? null;
}

/**
 * Match one blacklist term against an already-lowercased haystack.
 * @param {string} haystack
 * @param {string} item
 * @returns {boolean}
 */
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

/** Particles that negate the word following them ("nicht möbliert"). */
const NEGATION_PARTICLES = new Set(['kein', 'keine', 'keinen', 'keinem', 'keiner', 'nicht', 'ohne']);

/** German negation is a prefix: "unmöbliert", "unbefristet". */
const NEGATING_PREFIX = /^(un|nicht)/u;

/** Words containing "tausch" that do not offer a flat swap. */
const NON_SWAP_COMPOUND = /austausch|getausch|zutausch|umtausch|vertausch/u;

/** "contemporary design" is a style, not a temporary let. */
const NON_TEMPORARY_COMPOUND = /contemporar/u;

/**
 * "WG-tauglich"/"WG-geeignet" describes a normal flat whose layout would suit
 * flatmates. It is not an offer of a room in a shared flat, so it must not make
 * the listing look like one. Stripped before the WG token test; a genuine WG
 * mention anywhere else in the same text still counts.
 */
const WG_SUITABILITY_COMPOUND = /\bwg[-\s]?(tauglich|geeignet|f(ä|ae)hig)\w*/giu;

/**
 * Classify a configured blacklist term.
 *
 * A bare `includes` test is correct for portal names and multi-word phrases,
 * but it inverts the intent for two families of German terms:
 * - Negations are prefixes, so `möbliert` also matches `unmöbliert` and
 *   `furnished` also matches `unfurnished` — exactly the listings wanted.
 * - `Tausch` is a substring of `Austausch`/`ausgetauscht`, ordinary renovation
 *   wording with no swap on offer.
 *
 * Terms in those families are matched per word, so compounds such as
 * `teilmöbliert`, `befristeten` and `Untermietvertrag` still count, while
 * negated forms and known non-swap compounds do not.
 *
 * @param {string} term Already trimmed and lowercased term.
 * @returns {{stem: string, negatable: boolean, except?: RegExp}|null} Rule, or
 * null when the term keeps plain substring behaviour.
 */
function blacklistRule(term) {
  if (/^befristet/u.test(term)) return { stem: 'befristet', negatable: true };
  if (/m(ö|o)b|furnish/u.test(term)) return { stem: furnishingStem(term), negatable: true };
  if (term.includes('tausch')) return { stem: 'tausch', negatable: false, except: NON_SWAP_COMPOUND };
  if (/^(unter|zwischen)miete$/u.test(term)) return { stem: term.slice(0, -1), negatable: false };
  // English rental-intent terms inflect the same way German ones do, so they
  // need the per-word treatment too: "subletting" is a sublet, but
  // "contemporary" is not a temporary let.
  if (/^sublet/u.test(term)) return { stem: 'sublet', negatable: false };
  if (/^temporar/u.test(term)) return { stem: 'temporar', negatable: false, except: NON_TEMPORARY_COMPOUND };
  return null;
}

/**
 * Match a term that carries no inflection rule as a whole word or phrase.
 *
 * Plain `includes` was silently wrong for every such term: it rejected
 * "contemporary design" for `temporary` and "auf Zeitungspapier" for
 * `auf Zeit`. Word separators inside a phrase are matched loosely so
 * "short  term" and "short-term" still count.
 *
 * @param {string} haystack Already lowercased.
 * @param {string} term Already trimmed and lowercased.
 * @returns {boolean}
 */
function matchesPhrase(haystack, term) {
  const words = term.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return false;
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped.join('[^\\p{L}\\p{N}]+')}(?![\\p{L}\\p{N}])`, 'u');
  return pattern.test(haystack);
}

/**
 * Reduce a furnishing term to the stem shared by its compounds, so a single
 * configured spelling covers "teil-"/"voll-" prefixes and inflected endings.
 * @param {string} term
 * @returns {string}
 */
function furnishingStem(term) {
  return term.replace(/^(voll|teil|partly)\s*/u, '').replace(/e[rns]?$/u, '');
}

/**
 * Whether any word of the haystack contains the stem, honouring negations.
 * @param {string} haystack
 * @param {{stem: string, negatable: boolean, except?: RegExp}} rule
 * @returns {boolean}
 */
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

/**
 * Whether the haystack contains the token as a standalone word.
 * @param {string} haystack
 * @param {string} token
 * @returns {boolean}
 */
function hasToken(haystack, token) {
  return haystack.split(/[^\p{L}\p{N}]+/u).includes(token);
}

/**
 * Whether the haystack mentions a WG without negation ("keine WG" etc.).
 * @param {string} haystack
 * @returns {boolean}
 */
function hasWgToken(haystack) {
  // Drop "WG-tauglich" and friends first: they describe an ordinary flat, so
  // they must not stand in for a WG mention. Any other WG wording survives.
  const text = haystack.replace(WG_SUITABILITY_COMPOUND, ' ');
  const hasWg = hasToken(text, 'wg');
  const hasSharedFlat = hasToken(text, 'wohngemeinschaft');
  if (!hasWg && !hasSharedFlat) return false;

  const negativePattern = /(^|[^\p{L}\p{N}])(kein|keine|keinen|nicht)\s+(wg|wohngemeinschaft)([^\p{L}\p{N}]|$)/iu;
  if (negativePattern.test(text)) return false;

  return true;
}

/**
 * Check if a value is null or an empty string/array.
 * @param {any} val
 * @returns {boolean}
 */
function nullOrEmpty(val) {
  return val == null || val.length === 0;
}

/**
 * Convert a day time string (HH:mm) to epoch milliseconds for the given reference date.
 * @param {string} timeString - Format HH:mm
 * @param {number} now - Epoch ms used as the date basis
 * @returns {number}
 */
function timeStringToMs(timeString, now) {
  const d = new Date(now);
  const parts = timeString.split(':');
  d.setHours(parts[0]);
  d.setMinutes(parts[1]);
  d.setSeconds(0);
  return d.getTime();
}

/**
 * Determine whether the given timestamp is within the configured working hours, or return true when the window is not set.
 * - If workingHours is missing or either 'from' or 'to' is empty/null, returns true.
 * - Supports windows that cross midnight (e.g., from '23:00' to '06:00').
 *
 * Time parsing is based on the local timezone of the running process.
 *
 * @param {{workingHours?: {from?: string|null, to?: string|null}}} config - Configuration object containing working hours in 'HH:mm' format.
 * @param {number} now - Epoch milliseconds to evaluate.
 * @returns {boolean} True when execution is allowed at 'now'.
 * @example
 * // Same-day window
 * duringWorkingHoursOrNotSet({ workingHours: { from: '08:00', to: '17:00' } }, someTime);
 * @example
 * // Window crossing midnight
 * // For { from: '05:00', to: '00:30' } → 23:00 => true, 01:00 => false, 06:00 => true
 * duringWorkingHoursOrNotSet({ workingHours: { from: '05:00', to: '00:30' } }, Date.now());
 */
function duringWorkingHoursOrNotSet(config, now) {
  const { workingHours } = config;
  if (workingHours == null || nullOrEmpty(workingHours.from) || nullOrEmpty(workingHours.to)) {
    return true;
  }
  const toDate = timeStringToMs(workingHours.to, now);
  const fromDate = timeStringToMs(workingHours.from, now);

  // If parsing fails (e.g., malformed time), be lenient and allow.
  if (isNaN(toDate) || isNaN(fromDate)) {
    return true;
  }

  if (toDate >= fromDate) {
    // Same-day window (e.g., 08:00 - 17:00)
    return now >= fromDate && now <= toDate;
  }

  // Window crosses midnight (e.g., 05:00 -> 00:30 next day)
  // Accept if we are after 'from' today OR before 'to' today (which represents next day's cutoff).
  return now >= fromDate || now <= toDate;
}

/**
 * Return the directory name of the current module (ESM equivalent of __dirname).
 * @returns {string}
 */
function getDirName() {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Build a sha256 hash string from the provided inputs (ignores null/empty strings).
 * Returns null if there are no valid inputs.
 * @param {...(string|null|undefined)} inputs
 * @returns {string|null}
 */
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

/**
 * If the config exists, but cannot be accessed, we quit Fredy as something is fishy here.
 * @returns {Promise<boolean>}
 */
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

/**
 * Read config JSON from disk (conf/config.json) and parse it.
 * @returns {Promise<any>} Parsed configuration object.
 */
export async function readConfigFromStorage() {
  return JSON.parse(await readFile(new URL('../conf/config.json', import.meta.url)));
}

/**
 * Ensure the config file exists and is readable.
 * @returns {Promise<void>}
 */
export async function refreshConfig() {
  checkIfConfigExistsAndWriteIfNot();

  try {
    await readConfigFromStorage();
  } catch (error) {
    logger.info('Error reading config file.', error);
  }
}

/**
 * If the config file does not exist, create it with DEFAULT_CONFIG.
 * @returns {void}
 */
const checkIfConfigExistsAndWriteIfNot = () => {
  if (!fs.existsSync(`${getDirName()}/../conf/config.json`)) {
    logger.info('Could not find config file. Will create one with default values now');
    fs.writeFileSync(`${getDirName()}/../conf/config.json`, JSON.stringify({ ...DEFAULT_CONFIG }));
  }
};

/**
 * Normalize image URLs:
 * - Trim, remove stray '>' characters.
 * - Convert '/format/webp' segments to '/format/jpg'.
 * - Enforce HTTPS and ensure a valid image extension (jpg/png/gif). If URL contains '.jpg' without query, cut trailing parts.
 * - Return null for invalid inputs.
 * @param {string} url
 * @returns {string|null}
 */
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

/**
 * returns Fredy's version
 * @returns {Promise<*|string>}
 */
async function getPackageVersion() {
  try {
    const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const json = JSON.parse(packageJson);
    return json.version;
  } catch (error) {
    logger.error('Error reading version from package.json', error);
  }
  return 'N/A';
}

export {
  firstBlacklistMatch,
  normalizeImageUrl,
  nullOrEmpty,
  duringWorkingHoursOrNotSet,
  getDirName,
  buildHash,
  getPackageVersion,
  toJson,
  fromJson,
};
