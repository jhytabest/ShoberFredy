/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Structured extraction schema for the LLM listing parser.
 *
 * Every categorical field is enum-constrained so vocabulary cannot drift
 * between extractions, numeric fields carry sanity ranges, and everything
 * relevant that does not fit a structured field belongs in `comments`
 * (free text, original language). Availability is split into a normalized
 * enum plus an ISO date so free-text phrases like "ab sofort" never reach
 * the database.
 */

const LISTING_TYPES = ['rental', 'wg_room', 'sublet', 'swap', 'unknown'];
const PRICE_TYPES = ['cold', 'warm', 'unknown'];
const AVAILABILITY = ['immediate', 'date', 'date_range', 'flexible', 'unknown'];
const AVAILABILITY_PRECISION = ['exact_day', 'month', 'relative', 'unknown'];
const FURNISHING_STATUS = ['full', 'partial', 'none', 'unknown'];
const PETS_POLICIES = ['allowed', 'prohibited', 'conditional', 'preferred_no', 'unknown'];
const SMOKING_POLICIES = ['allowed', 'prohibited', 'conditional', 'unknown'];
const LEASE_TYPES = ['unlimited', 'fixed', 'sublet', 'swap', 'unknown'];
const PROPERTY_TYPES = [
  'apartment',
  'ground_floor_apartment',
  'attic_apartment',
  'penthouse',
  'maisonette',
  'loft',
  'studio',
  'souterrain',
  'house',
  'shared_room',
  'other',
  'unknown',
];
const CONDITIONS = [
  'first_occupancy',
  'like_new',
  'renovated',
  'refurbished',
  'first_occupancy_after_renovation',
  'well_maintained',
  'needs_renovation',
  'unknown',
];
const HEATING_TYPES = [
  'central',
  'district',
  'gas',
  'oil',
  'heat_pump',
  'electric',
  'underfloor',
  'wood_pellet',
  'other',
  'unknown',
];
const ENERGY_CLASSES = ['A+', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const AMENITIES = [
  'balcony',
  'terrace',
  'garden',
  'garden_use',
  'elevator',
  'fitted_kitchen',
  'cellar',
  'parking',
  'garage',
  'underground_parking',
  'bathtub',
  'shower',
  'guest_toilet',
  'furnished',
  'partially_furnished',
  'dishwasher',
  'washing_machine',
  'washing_machine_connection',
  'floorboards',
  'parquet',
  'tiles',
  'underfloor_heating',
  'high_ceilings',
  'stucco',
  'old_building',
  'new_building',
  'barrier_free',
  'wheelchair_accessible',
  'storage_room',
  'bicycle_room',
  'attic',
  'fireplace',
  'air_conditioning',
  'smart_home',
  'pool',
  'sauna',
  'concierge',
  'pets_welcome',
  'wg_suitable',
];
const RENT_INCLUSIONS = [
  'service_charges',
  'heating',
  'electricity',
  'internet',
  'furniture',
  'parking',
  'broadcast_fee',
];
const REQUIREMENTS = [
  'wbs',
  'proof_of_income',
  'schufa',
  'identity_document',
  'guarantor',
  'employment',
  'no_jobcenter',
  'single_occupancy',
  'non_smoker',
  'registration_possible',
  'online_viewing',
];

const CURRENT_YEAR = new Date().getUTCFullYear();

export const listingTool = {
  type: 'function',
  function: {
    name: 'submit_listing',
    description:
      'Submit the normalized structured real-estate listing. Use null when a fact is genuinely unavailable. ' +
      'Everything relevant that does not fit a structured field goes into `comments`.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [
        'title',
        'listing_type',
        'address',
        'availability',
        'available_from',
        'size_sqm',
        'rooms',
        'bedrooms',
        'bathrooms',
        'floor',
        'total_floors',
        'building_year',
        'property_type',
        'condition',
        'furnished',
        'rent',
        'energy',
        'pets_allowed',
        'amenities',
        'comments',
      ],
      properties: {
        title: nullable('string'),
        listing_type: {
          type: 'string',
          enum: LISTING_TYPES,
          description: 'rental = ordinary rental flat; swap = Tauschwohnung; wg_room = room in a shared flat.',
        },
        address: nullable('string', 'Most precise address available, ideally street-level.'),
        address_components: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['street', 'house_number', 'postal_code', 'city', 'district', 'country_code', 'precision'],
          properties: {
            street: nullable('string'),
            house_number: nullable('string'),
            postal_code: nullable('string'),
            city: nullable('string'),
            district: nullable('string'),
            country_code: { type: ['string', 'null'], enum: ['DE', null] },
            precision: { type: 'string', enum: ['exact', 'street', 'postcode', 'district', 'city', 'unknown'] },
          },
        },
        availability: {
          type: 'string',
          enum: AVAILABILITY,
          description: 'immediate = available now/sofort; date = a concrete date is named; flexible = negotiable.',
        },
        available_from: {
          type: ['string', 'null'],
          description: 'ISO YYYY-MM-DD for an exact day or YYYY-MM for month precision. Never invent a day.',
        },
        availability_precision: { type: 'string', enum: AVAILABILITY_PRECISION },
        available_until: {
          type: ['string', 'null'],
          description: 'ISO YYYY-MM-DD or YYYY-MM using the same precision rules.',
        },
        size_sqm: nullableNumber(1, 2000),
        rooms: nullableNumber(0.5, 20),
        bedrooms: nullableNumber(0, 15),
        bathrooms: nullableNumber(0, 10),
        floor: nullableNumber(-2, 60, 'Ground floor (Erdgeschoss) = 0.'),
        total_floors: nullableNumber(1, 80),
        building_year: nullableNumber(1200, CURRENT_YEAR + 5),
        property_type: { type: ['string', 'null'], enum: [...PROPERTY_TYPES, null] },
        condition: { type: ['string', 'null'], enum: [...CONDITIONS, null] },
        furnished: nullable('boolean'),
        furnishing_status: { type: 'string', enum: FURNISHING_STATUS },
        pets_policy: { type: 'string', enum: PETS_POLICIES },
        smoking_policy: { type: 'string', enum: SMOKING_POLICIES },
        lease_type: { type: 'string', enum: LEASE_TYPES },
        minimum_lease_months: nullableNumber(0, 240),
        maximum_occupants: nullableNumber(1, 50),
        rent: {
          type: 'object',
          additionalProperties: false,
          required: ['cold', 'warm', 'service_charges', 'heating_costs', 'deposit', 'price_type'],
          properties: {
            cold: nullableNumber(0, 50000),
            warm: nullableNumber(0, 50000),
            service_charges: nullableNumber(0, 10000),
            heating_costs: nullableNumber(0, 10000),
            deposit: nullableNumber(0, 200000),
            price_type: {
              type: 'string',
              enum: PRICE_TYPES,
              description: 'What the headline price of the listing refers to.',
            },
            currency: { type: 'string', enum: ['EUR'] },
            period: { type: 'string', enum: ['month'] },
            electricity: nullableNumber(0, 10000),
            internet: nullableNumber(0, 10000),
            parking: nullableNumber(0, 10000),
            furniture: nullableNumber(0, 10000),
            other_recurring: nullableNumber(0, 10000),
            one_time_buyout: nullableNumber(0, 200000),
            included: { type: 'array', items: { type: 'string', enum: RENT_INCLUSIONS } },
          },
        },
        energy: {
          type: 'object',
          additionalProperties: false,
          required: ['class', 'value_kwh', 'heating_type'],
          properties: {
            class: { type: ['string', 'null'], enum: [...ENERGY_CLASSES, null] },
            value_kwh: nullableNumber(0, 1500),
            heating_type: { type: ['string', 'null'], enum: [...HEATING_TYPES, null] },
          },
        },
        pets_allowed: nullable('boolean'),
        amenities: {
          type: 'array',
          items: { type: 'string', enum: AMENITIES },
          description: 'Only amenities from the fixed vocabulary. Anything else belongs in comments.',
        },
        amenities_absent: {
          type: 'array',
          items: { type: 'string', enum: AMENITIES },
          description: 'Amenities the detail evidence explicitly says are absent. Unlisted amenities remain unknown.',
        },
        requirements: { type: 'array', items: { type: 'string', enum: REQUIREMENTS } },
        conflicts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Concise conflicting source claims that cannot be resolved without guessing.',
        },
        comments: {
          type: ['string', 'null'],
          description:
            'All remaining relevant facts that do not fit the structured fields, in the original language: ' +
            'swap requirements, WG constraints, application process, quirks, view, neighbourhood notes. ' +
            'Concise plain text. null when nothing remains.',
        },
      },
    },
  },
};

/**
 * Validate an LLM extraction against the schema: structure, enums, and
 * numeric ranges. Additionally enforces the availability/available_from
 * pairing that JSON schema alone cannot express.
 *
 * @param {object} value candidate tool-call arguments
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateListing(value) {
  const errors = [];
  validateObject(value, listingTool.function.parameters, '$', errors);
  if (errors.length === 0) {
    if (value.availability === 'date' || value.availability === 'date_range') {
      const monthPrecision = value.availability_precision === 'month';
      if (!(monthPrecision ? isIsoMonth(value.available_from) : isIsoDate(value.available_from))) {
        errors.push(
          monthPrecision
            ? '$.available_from must be an ISO month (YYYY-MM)'
            : '$.available_from must be an ISO date (YYYY-MM-DD)',
        );
      }
      if (value.availability === 'date_range' && value.available_until == null) {
        errors.push('$.available_until is required when availability is "date_range"');
      }
      if (
        value.available_until != null &&
        !(monthPrecision ? isIsoMonth(value.available_until) : isIsoDate(value.available_until))
      ) {
        errors.push(
          monthPrecision
            ? '$.available_until must be an ISO month (YYYY-MM)'
            : '$.available_until must be an ISO date (YYYY-MM-DD)',
        );
      }
      if (
        value.available_until != null &&
        value.available_from != null &&
        value.available_until < value.available_from
      ) {
        errors.push('$.available_until must be >= $.available_from');
      }
    } else if (value.available_from != null) {
      errors.push('$.available_from must be null unless availability is "date" or "date_range"');
    } else if (value.available_until != null) {
      errors.push('$.available_until must be null unless availability is "date_range"');
    }
    const { cold, warm, service_charges: serviceCharges, heating_costs: heatingCosts } = value.rent;
    if (cold != null && warm != null && warm < cold) errors.push('$.rent.warm must be >= $.rent.cold');
    if (warm != null && serviceCharges != null && heatingCosts != null && serviceCharges + heatingCosts > warm) {
      errors.push('$.rent charges must not exceed $.rent.warm');
    }
    if (new Set(value.amenities).size !== value.amenities.length) {
      errors.push('$.amenities must not contain duplicates');
    }
    const absent = value.amenities_absent || [];
    if (new Set(absent).size !== absent.length) errors.push('$.amenities_absent must not contain duplicates');
    const overlap = value.amenities.filter((amenity) => absent.includes(amenity));
    if (overlap.length) errors.push('$.amenities and $.amenities_absent must not overlap');
    if (value.bedrooms != null && value.rooms != null && value.bedrooms > value.rooms) {
      errors.push('$.bedrooms must be <= $.rooms');
    }
    if (value.floor != null && value.total_floors != null && value.floor > value.total_floors) {
      errors.push('$.floor must be <= $.total_floors');
    }
    for (const [path, number] of [
      ['$.building_year', value.building_year],
      ['$.total_floors', value.total_floors],
      ['$.minimum_lease_months', value.minimum_lease_months],
      ['$.maximum_occupants', value.maximum_occupants],
    ]) {
      if (number != null && !Number.isInteger(number)) errors.push(`${path} must be an integer`);
    }
    if (value.furnishing_status === 'none' && value.furnished !== false) {
      errors.push('$.furnished must be false when furnishing_status is "none"');
    }
    if (['full', 'partial'].includes(value.furnishing_status) && value.furnished !== true) {
      errors.push('$.furnished must be true when furnishing_status is full or partial');
    }
    if (value.furnishing_status === 'unknown' && value.furnished != null) {
      errors.push('$.furnished must be null when furnishing_status is "unknown"');
    }
    if (value.pets_policy === 'allowed' && value.pets_allowed !== true) {
      errors.push('$.pets_allowed must be true when pets_policy is "allowed"');
    }
    if (value.pets_policy === 'prohibited' && value.pets_allowed !== false) {
      errors.push('$.pets_allowed must be false when pets_policy is "prohibited"');
    }
    if (['conditional', 'preferred_no', 'unknown'].includes(value.pets_policy) && value.pets_allowed != null) {
      errors.push('$.pets_allowed must be null for conditional, preferred_no, or unknown pets_policy');
    }
    for (const [path, values] of [
      ['$.rent.included', value.rent.included || []],
      ['$.requirements', value.requirements || []],
      ['$.conflicts', value.conflicts || []],
    ]) {
      if (new Set(values).size !== values.length) errors.push(`${path} must not contain duplicates`);
    }
  }
  return { valid: errors.length === 0, errors };
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // Date.parse silently normalizes impossible dates (2026-02-31 → March 3),
  // so round-trip through UTC and require the exact same calendar day back.
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isIsoMonth(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) return false;
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
}

function validateObject(value, schema, path, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const allowed = new Set(Object.keys(schema.properties || {}));
  for (const key of schema.required || []) {
    if (!(key in value)) errors.push(`${path}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(`${path}.${key} is not allowed`);
      continue;
    }
    validateValue(value[key], schema.properties[key], `${path}.${key}`, errors);
  }
}

function validateValue(value, schema, path, errors) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!types.includes(actual)) {
    errors.push(`${path} must be ${types.join(' or ')}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} has an invalid value`);
  if (actual === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }
  if (actual === 'object') validateObject(value, schema, path, errors);
  if (actual === 'array') {
    value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`, errors));
  }
}

function nullable(type, description) {
  const schema = { type: [type, 'null'] };
  if (description) schema.description = description;
  return schema;
}

function nullableNumber(minimum, maximum, description) {
  const schema = { type: ['number', 'null'], minimum, maximum };
  if (description) schema.description = description;
  return schema;
}
