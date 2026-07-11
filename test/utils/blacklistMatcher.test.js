/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';
import { isOneOf } from '../../lib/utils.js';

describe('isOneOf blacklist matching', () => {
  it('matches plain substrings case-insensitively', () => {
    expect(isOneOf('Schöne Wohnung mit Balkon', ['balkon'])).toBe(true);
    expect(isOneOf('Schöne Wohnung', ['balkon'])).toBe(false);
  });

  it('returns false for empty inputs', () => {
    expect(isOneOf(null, ['x'])).toBe(false);
    expect(isOneOf('word', [])).toBe(false);
    expect(isOneOf('word', null)).toBe(false);
  });

  describe("token-aware 'wg' handling", () => {
    it('matches WG as a standalone token', () => {
      expect(isOneOf('Zimmer in 3er WG frei', ['wg'])).toBe(true);
      expect(isOneOf('WG-Zimmer in Mitte', ['wg'])).toBe(true);
    });

    it('does not match wg inside other words', () => {
      expect(isOneOf('Wegweiser zum Glück', ['wg'])).toBe(false);
      expect(isOneOf('Umzugswagen vorhanden', ['wg'])).toBe(false);
    });

    it('ignores negated WG phrases', () => {
      expect(isOneOf('Keine WG erwünscht', ['wg'])).toBe(false);
      expect(isOneOf('nicht WG geeignet', ['wg'])).toBe(false);
    });
  });

  describe("token-aware 'befristet' handling", () => {
    it('matches befristet as a standalone token', () => {
      expect(isOneOf('Wohnung befristet bis 2027', ['befristet'])).toBe(true);
    });

    it('does not match unbefristet', () => {
      expect(isOneOf('Unbefristeter Mietvertrag', ['befristet'])).toBe(false);
      expect(isOneOf('unbefristet zu vermieten', ['befristet'])).toBe(false);
    });
  });
});
