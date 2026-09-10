/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export function isRecoverableParseFailure(work) {
  if (work?.kind !== 'parse' || work.status !== 'dead') return false;
  if (work.outcome_code === 'llm_unextractable') {
    return /fetch failed|OpenRouter .*deadline|OpenRouter request failed: (?:404|408|429|5\d\d)\b|upstream.*(?:capacity|overload|unavailable)/i.test(
      work.last_error || '',
    );
  }
  return (
    work.outcome_code === 'parked_out' &&
    /waiting:.*(?:OpenRouter|LLM|Google geocod|geocoding)/i.test(work.outcome_note || '')
  );
}
