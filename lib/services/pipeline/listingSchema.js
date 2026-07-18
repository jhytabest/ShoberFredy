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
const AVAILABILITY = ['immediate', 'date', 'flexible', 'unknown'];
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
        availability: {
          type: 'string',
          enum: AVAILABILITY,
          description: 'immediate = available now/sofort; date = a concrete date is named; flexible = negotiable.',
        },
        available_from: {
          type: ['string', 'null'],
          description: 'ISO date YYYY-MM-DD. Required when availability = "date", null otherwise.',
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
    if (value.availability === 'date') {
      if (!isIsoDate(value.available_from)) errors.push('$.available_from must be an ISO date (YYYY-MM-DD)');
    } else if (value.available_from != null) {
      errors.push('$.available_from must be null unless availability is "date"');
    }
  }
  return { valid: errors.length === 0, errors };
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
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
