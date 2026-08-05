/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const LISTING_TYPES = ['rental', 'wg_room', 'sublet', 'swap', 'unknown'];
const AVAILABILITY_TOKENS = ['immediate', 'flexible', 'unknown'];
const FURNISHING_STATUS = ['full', 'partial', 'none', 'unknown'];
const PETS_POLICIES = ['allowed', 'prohibited', 'conditional', 'preferred_no', 'unknown'];
const LEASE_TYPES = ['unlimited', 'fixed', 'sublet', 'swap', 'unknown'];
const OFFERED_BY = ['private', 'agency', 'property_management', 'relisting_platform', 'unknown'];
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
  'guest_toilet',
  'dishwasher',
  'washing_machine',
  'parquet',
  'underfloor_heating',
  'old_building',
  'new_building',
  'barrier_free',
  'wheelchair_accessible',
  'fireplace',
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
        'available_from',
        'available_until',
        'size_sqm',
        'rooms',
        'bedrooms',
        'bathrooms',
        'floor',
        'total_floors',
        'building_year',
        'property_type',
        'condition',
        'furnishing_status',
        'lease_type',
        'offered_by',
        'rent',
        'energy_class',
        'pets_policy',
        'amenities',
        'comments',
        'summary',
      ],
      properties: {
        title: nullable('string'),
        listing_type: {
          type: 'string',
          enum: LISTING_TYPES,
          description: 'rental = ordinary rental flat; swap = Tauschwohnung; wg_room = room in a shared flat.',
        },
        address: nullable('string', 'Most precise address available, ideally street-level.'),
        available_from: {
          type: 'string',
          pattern: '^(immediate|flexible|unknown|\\d{4}-\\d{2}(-\\d{2})?)$',
          description:
            'When the flat becomes available, exactly as the listing states it: "immediate" for sofort/ab sofort, ' +
            '"flexible" for nach Absprache/verhandelbar, "unknown" when the evidence does not say, YYYY-MM-DD when ' +
            'a day is named, or YYYY-MM when only a month is named. Never invent a day.',
        },
        available_until: {
          type: ['string', 'null'],
          description:
            'End of a time-limited offer as YYYY-MM-DD or YYYY-MM; null when the tenancy is open-ended or unstated.',
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
        furnishing_status: {
          type: 'string',
          enum: FURNISHING_STATUS,
          description:
            'full = vollmöbliert, the flat comes with its furniture. partial = teilmöbliert, some fitted or left ' +
            'items such as an Einbauküche or built-in wardrobes but not a furnished home. none = unmöbliert, ' +
            'including a flat with only an Einbauküche mentioned as an amenity. unknown when the advert does not say.',
        },
        pets_policy: { type: 'string', enum: PETS_POLICIES },
        lease_type: {
          type: ['string', 'null'],
          enum: [...LEASE_TYPES, null],
          description:
            'unlimited = unbefristet, an open-ended Mietvertrag. fixed = befristet or a stated end date. ' +
            'sublet = Untermiete/Zwischenmiete. swap = Tauschwohnung. Answer unlimited when the advert offers an ' +
            'ordinary tenancy without naming an end, which is the German default; unknown only when it is genuinely silent.',
        },
        offered_by: {
          type: ['string', 'null'],
          enum: [...OFFERED_BY, null],
          description:
            'Who is advertising: relisting_platform for an intermediary reselling or subletting other ' +
            "people's flats (HousingAnywhere, Spotahome, Wunderflats, Homelike, Nestpick and similar), " +
            'agency for a Makler, property_management for a Hausverwaltung, private when the landlord or ' +
            'current tenant advertises directly.',
        },
        rent: {
          type: 'object',
          additionalProperties: false,
          required: ['cold', 'warm', 'deposit'],
          properties: {
            cold: nullableNumber(
              0,
              50000,
              'Kaltmiete, the monthly rent before service charges. Null when the advert does not state ' +
                'one — do not derive it from a Warmmiete.',
            ),
            warm: nullableNumber(
              0,
              50000,
              'Warmmiete, the monthly rent including service charges. Null when the advert does not ' +
                'state one — do not derive it from a Kaltmiete.',
            ),
            deposit: nullableNumber(0, 200000),
          },
        },
        energy_class: { type: ['string', 'null'], enum: [...ENERGY_CLASSES, null] },
        amenities: {
          type: 'array',
          maxItems: AMENITIES.length,
          description:
            'Every amenity the evidence explicitly settles, from the fixed vocabulary: present true when the listing ' +
            'has it, present false when the listing explicitly says it does not. Leave an amenity out entirely when the ' +
            'evidence does not settle it — omission means unknown. Anything outside the vocabulary belongs in comments.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'present'],
            properties: {
              name: { type: 'string', enum: AMENITIES },
              present: { type: 'boolean' },
            },
          },
        },
        comments: {
          type: ['string', 'null'],
          description:
            'All remaining relevant facts that do not fit the structured fields, in the original language: ' +
            'application requirements (WBS, Schufa, proof of income, guarantor), swap requirements, WG ' +
            'constraints, notable features outside the amenity vocabulary, the application process, quirks, ' +
            'view, neighbourhood notes, and any contradiction in the advert you could not resolve. ' +
            'Concise plain text. null when nothing remains.',
        },
        summary: {
          type: ['string', 'null'],
          description:
            'A 1-3 sentence neutral summary of the listing for a notification, in the original language (German). ' +
            'Cover what matters to a renter: area/location, price and whether it looks fair for the size, size/rooms, ' +
            'condition and standout features, and any catch (e.g. Tausch only, WBS required, short-term, WG). ' +
            'Factual, no marketing fluff, no invented facts. null only when there is genuinely nothing to say.',
        },
      },
    },
  },
};

export function validateListing(value) {
  const errors = [];
  validateObject(value, listingTool.function.parameters, '$', errors);
  if (errors.length === 0) {
    if (!isAvailability(value.available_from)) {
      errors.push(`$.available_from must be ${AVAILABILITY_TOKENS.join(', ')}, YYYY-MM-DD, or YYYY-MM`);
    }
    if (value.available_until != null) {
      if (!isIsoDate(value.available_until) && !isIsoMonth(value.available_until)) {
        errors.push('$.available_until must be an ISO date (YYYY-MM-DD) or month (YYYY-MM)');
      } else if (isDateValue(value.available_from) && endsBeforeStart(value.available_from, value.available_until)) {
        errors.push('$.available_until must be >= $.available_from');
      }
    }
    const { cold, warm } = value.rent;
    if (cold != null && warm != null && warm < cold) errors.push('$.rent.warm must be >= $.rent.cold');
    const amenityNames = value.amenities.map((amenity) => amenity?.name);
    if (new Set(amenityNames).size !== amenityNames.length) {
      errors.push('$.amenities must not name the same amenity twice');
    }
    if (value.bedrooms != null && value.rooms != null && value.bedrooms > value.rooms) {
      errors.push('$.bedrooms must be <= $.rooms');
    }
    if (value.floor != null && value.total_floors != null && value.floor > value.total_floors) {
      errors.push('$.floor must be <= $.total_floors');
    }
    for (const [path, number] of [
      ['$.building_year', value.building_year],
      ['$.total_floors', value.total_floors],
    ]) {
      if (number != null && !Number.isInteger(number)) errors.push(`${path} must be an integer`);
    }
  }
  return { valid: errors.length === 0, errors };
}

function isDateValue(value) {
  return isIsoDate(value) || isIsoMonth(value);
}

function isAvailability(value) {
  return AVAILABILITY_TOKENS.includes(value) || isDateValue(value);
}

function endsBeforeStart(from, until) {
  const monthOnly = isIsoMonth(from) || isIsoMonth(until);
  return (monthOnly ? until.slice(0, 7) : until) < (monthOnly ? from.slice(0, 7) : from);
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
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
