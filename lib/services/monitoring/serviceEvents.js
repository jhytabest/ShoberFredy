/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const counters = new Map();

/**
 * Record a low-cardinality operational event for the metrics exporter.
 * Product data stays in its owning subsystem; this registry is only for
 * process-local events that used to be reconstructed by grepping Docker logs.
 *
 * @param {string} event
 * @param {'warning'|'critical'} severity
 */
export function recordServiceEvent(event, severity = 'warning') {
  const key = `${severity}:${event}`;
  counters.set(key, (counters.get(key) || 0) + 1);
}

/** @returns {{event: string, severity: string, count: number}[]} */
export function serviceEventSnapshot() {
  return [...counters.entries()].map(([key, count]) => {
    const separator = key.indexOf(':');
    return {
      severity: key.slice(0, separator),
      event: key.slice(separator + 1),
      count,
    };
  });
}
