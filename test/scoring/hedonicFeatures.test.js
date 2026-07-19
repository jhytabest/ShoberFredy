/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';
import {
  hedonicDesignVector,
  hedonicDimensions,
  hedonicTermNames,
  structuredFeatureFlags,
  dot,
  clamp,
  MAX_MONTH_OFFSETS,
} from '../../lib/services/scoring/hedonicFeatures.js';

describe('hedonicFeatures', () => {
  const baseListing = {
    size: 70,
    rooms: 2,
    floor: null,
    buildingYear: null,
    propertyType: null,
    priceType: 'cold',
    features: {},
    monthOffset: 0,
  };

  it('design vector length matches dimensions and term names', () => {
    const vector = hedonicDesignVector(baseListing);
    expect(vector).toHaveLength(hedonicDimensions());
    expect(hedonicTermNames()).toHaveLength(hedonicDimensions());
  });

  it('baseline listing has intercept 1 and zero deviations', () => {
    const vector = hedonicDesignVector(baseListing);
    expect(vector[0]).toBe(1); // intercept
    expect(vector[1]).toBeCloseTo(0); // log(70/70)
    expect(vector[2]).toBe(0); // rooms at baseline
  });

  it('month offset dummies are one-hot and capped', () => {
    const names = hedonicTermNames();
    const monthStart = names.indexOf('month_1');
    const vector = hedonicDesignVector({ ...baseListing, monthOffset: 3 });
    expect(vector[monthStart + 2]).toBe(1);
    expect(vector.slice(monthStart).filter((v) => v === 1)).toHaveLength(1);

    const capped = hedonicDesignVector({ ...baseListing, monthOffset: 99 });
    expect(capped[monthStart + MAX_MONTH_OFFSETS - 1]).toBe(1);
  });

  it('feature flags use only structured LLM fields', () => {
    const flags = structuredFeatureFlags({
      amenities: ['balcony', 'fitted_kitchen'],
      condition: 'renovated',
    });
    expect(flags.balcony).toBe(true);
    expect(flags.renovated).toBe(true);
    expect(flags.fitted_kitchen).toBe(true);
    expect(flags.garden).toBe(false);
  });

  it('dot and clamp behave as expected', () => {
    expect(dot([1, 2], [3, 4])).toBe(11);
    expect(clamp(10, 0, 5)).toBe(5);
    expect(clamp(-1, 0, 5)).toBe(0);
  });
});
