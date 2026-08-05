/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { quantile, roundMetric } from '../stats.js';

export function addHeader(lines, name, type, help) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
}

export function metric(lines, name, value, labels = {}) {
  if (!Number.isFinite(value)) return;
  const labelEntries = Object.entries(labels);
  const labelText = labelEntries.length
    ? `{${labelEntries.map(([key, labelValue]) => `${key}="${escapeLabel(labelValue)}"`).join(',')}}`
    : '';
  lines.push(`${name}${labelText} ${roundMetric(value)}`);
}

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

export function numberLabel(value) {
  if (value == null || value === '') return '';
  const rounded = roundMetric(Number(value));
  return rounded == null ? '' : String(rounded);
}

export function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

export function shortenLabel(value, maxLength) {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

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

export function ratio(part, total) {
  return total > 0 ? part / total : 0;
}
