/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const counters = new Map();

export function recordServiceEvent(event, severity = 'warning') {
  const key = `${severity}:${event}`;
  counters.set(key, (counters.get(key) || 0) + 1);
}

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
