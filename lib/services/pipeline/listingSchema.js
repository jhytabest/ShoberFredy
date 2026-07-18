/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const LISTING_TYPES = ['apartment', 'wg_room', 'sublet', 'swap', 'unknown'];
const PRICE_TYPES = ['cold', 'warm', 'unknown'];

export const listingTool = {
  type: 'function',
  function: {
    name: 'submit_listing',
    description: 'Submit the normalized structured real-estate listing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [
        'title',
        'listing_type',
        'address',
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
      ],
      properties: {
        title: nullable('string'),
        listing_type: { type: 'string', enum: LISTING_TYPES },
        address: nullable('string'),
        available_from: nullable('string'),
        size_sqm: nullable('number'),
        rooms: nullable('number'),
        bedrooms: nullable('number'),
        bathrooms: nullable('number'),
        floor: nullable('number'),
        total_floors: nullable('number'),
        building_year: nullable('number'),
        property_type: nullable('string'),
        condition: nullable('string'),
        furnished: nullable('boolean'),
        rent: {
          type: 'object',
          additionalProperties: false,
          required: ['cold', 'warm', 'service_charges', 'heating_costs', 'deposit', 'price_type'],
          properties: {
            cold: nullable('number'),
            warm: nullable('number'),
            service_charges: nullable('number'),
            heating_costs: nullable('number'),
            deposit: nullable('number'),
            price_type: { type: 'string', enum: PRICE_TYPES },
          },
        },
        energy: {
          type: 'object',
          additionalProperties: false,
          required: ['class', 'value_kwh', 'heating_type'],
          properties: {
            class: nullable('string'),
            value_kwh: nullable('number'),
            heating_type: nullable('string'),
          },
        },
        pets_allowed: nullable('boolean'),
        amenities: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

export function validateListing(value) {
  const errors = [];
  validateObject(value, listingTool.function.parameters, '$', errors);
  return { valid: errors.length === 0, errors };
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
  if (actual === 'object') validateObject(value, schema, path, errors);
  if (actual === 'array') {
    value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`, errors));
  }
}

function nullable(type) {
  return { type: [type, 'null'] };
}
