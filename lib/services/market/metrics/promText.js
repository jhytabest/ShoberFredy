/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Prometheus text-format primitives. Every collector renders through these, so
 * escaping, rounding and the HELP/TYPE preamble are stated once: a malformed
 * label anywhere would make Prometheus reject the whole scrape, not just the
 * offending series.
 */

import { quantile, roundMetric } from '../stats.js';

/**
 * Emit the HELP/TYPE preamble for a metric family. Call once per family,
 * before its samples — Prometheus expects the samples of one family to be
 * contiguous.
 *
 * @param {string[]} lines
 * @param {string} name
 * @param {'gauge'|'counter'} type
 * @param {string} help
 */
export function addHeader(lines, name, type, help) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
}

/**
 * Emit one sample. Non-finite values are dropped rather than rendered as NaN:
 * an absent series is a truthful "no data", a NaN sample is not.
 *
 * @param {string[]} lines
 * @param {string} name
 * @param {number} value
 * @param {Record<string, string|number>} [labels]
 */
export function metric(lines, name, value, labels = {}) {
  if (!Number.isFinite(value)) return;
  const labelEntries = Object.entries(labels);
  const labelText = labelEntries.length
    ? `{${labelEntries.map(([key, labelValue]) => `${key}="${escapeLabel(labelValue)}"`).join(',')}}`
    : '';
  lines.push(`${name}${labelText} ${roundMetric(value)}`);
}

/**
 * Emit the standard p10..p90 quantile set of a value list under one family.
 *
 * @param {string[]} lines
 * @param {string} name
 * @param {number[]} values
 * @param {Record<string, string|number>} [extraLabels]
 */
export function emitQuantiles(lines, name, values, extraLabels = {}) {
  for (const [label, q] of [
    ['p10', 0.1],
    ['p25', 0.25],
    ['p50', 0.5],
    ['p75', 0.75],
    ['p90', 0.9],
  ]) {
    metric(lines, name, quantile(values, q) || 0, { ...extraLabels, quantile: label });
  }
}

/**
 * Render a number as a label value. Absent numbers become the empty string;
 * `null` or `NaN` inside a label reads as data to whoever looks at the panel.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function numberLabel(value) {
  // Number(null) is 0, so absence has to be caught before the conversion —
  // otherwise "rooms unknown" renders as a confident "0 rooms".
  if (value == null || value === '') return '';
  const rounded = roundMetric(Number(value));
  return rounded == null ? '' : String(rounded);
}

/** @param {unknown} value @returns {string} */
export function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/**
 * Truncate a free-text label. Titles and links ride along as labels for the
 * dashboard tables, and an unbounded label blows up series size for no gain.
 *
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string}
 */
export function shortenLabel(value, maxLength) {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * Group rows by a derived key, preserving first-seen order.
 *
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => string} keyFn
 * @returns {Map<string, T[]>}
 */
export function groupBy(rows, keyFn) {
  const out = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const group = out.get(key);
    if (group) group.push(row);
    else out.set(key, [row]);
  }
  return out;
}

/** Share of `part` in `total`, zero for an empty total. */
export function ratio(part, total) {
  return total > 0 ? part / total : 0;
}
