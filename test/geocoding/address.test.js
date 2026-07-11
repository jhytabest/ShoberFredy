/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';
import { normalizeAddress, addressKey } from '../../lib/services/geocoding/address.js';

describe('address normalization', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeAddress('  Torstraße   12 ,  10119 Berlin ')).toBe('Torstraße 12, 10119 Berlin');
  });

  it('addressKey lowercases the normalized address', () => {
    expect(addressKey('Torstraße 12, 10119 BERLIN')).toBe('torstraße 12, 10119 berlin');
  });

  it('handles null and empty values', () => {
    expect(normalizeAddress(null)).toBe('');
    expect(addressKey(undefined)).toBe('');
  });
});
