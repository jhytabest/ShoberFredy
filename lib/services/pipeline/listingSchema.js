/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export const EXTRACTION_VERSION = 12;
export const OFFER_KINDS = ['rental', 'swap', 'wanted', 'sale', 'holiday', 'other', 'unknown'];
export const UNIT_KINDS = ['entire_home', 'private_room', 'shared_room', 'unknown'];
export const RENTAL_ARRANGEMENTS = ['direct', 'sublet', 'unknown'];
export const LEASE_DURATIONS = ['indefinite', 'fixed', 'unstated'];
const AVAILABILITY_TOKENS = ['immediate', 'flexible', 'unknown'];
export const FURNISHING_STATUS = ['full', 'partial', 'none', 'unknown'];
const PETS_POLICIES = ['allowed', 'prohibited', 'conditional', 'preferred_no', 'unknown'];
export const OFFERED_BY = ['private', 'agency', 'property_management', 'relisting_platform', 'unknown'];
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
export const CONDITIONS = [
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
export const AMENITIES = [
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
      "Submit the normalized structured real-estate listing. Use the schema's unknown/unstated value or null for unavailable facts. " +
      'Everything relevant that does not fit a structured field goes into `comments`.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [
        'title',
        'offer_kind',
        'unit_kind',
        'rental_arrangement',
        'lease_duration',
        'minimum_term_months',
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
        'altbau',
        'property_type',
        'condition',
        'furnishing_status',
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
        offer_kind: {
          type: 'string', enum: OFFER_KINDS,
          description: 'Classify the advert itself: rental for a residential tenancy, holiday for vacation accommodation, wanted for a search request, other for services/events without an individual home on offer. Unknown when unclear.',
        },
        unit_kind: {
          type: 'string',
          enum: UNIT_KINDS,
          description: 'The unit actually offered, not the whole flat surrounding a room.',
        },
        rental_arrangement: {
          type: 'string', enum: RENTAL_ARRANGEMENTS,
          description: 'Sublet means the tenant remains the main tenant and lets to someone else. A Nachmieter replacing a departing tenant is not a sublet. Unknown if the contractual arrangement is unclear.',
        },
        lease_duration: {
          type: 'string',
          enum: LEASE_DURATIONS,
          description:
            'fixed only for an explicit end or explicitly temporary lease. A minimum stay does not make a lease fixed. unstated when no duration is stated.',
        },
        minimum_term_months: nullableNumber(
          0,
          120,
          'Explicit minimum commitment, independently of whether the lease has an end.',
        ),
        address: nullable('string', 'The offered property address, not the advertiser location. Resolve location from the actual offer; preserve null when conflicting details cannot be resolved.'),
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
        floor: nullableNumber(
          -2,
          60,
          '3. OG/Stock/dritter Stock/3 von 5 = 3; EG/Parterre/Hochparterre = 0; UG/Souterrain = -1; DG without a numbered storey = null.',
        ),
        total_floors: nullableNumber(1, 80),
        building_year: nullableNumber(
          1200,
          CURRENT_YEAR + 5,
          'Explicit construction year only; never infer a year from location, style, renovation or near-new condition.',
        ),
        altbau: nullable('boolean', 'Building character: true for an Altbau, false for a clearly non-Altbau, null when unclear. Judge the whole context, including explicit Altbau descriptions and architecture. Renovation does not change building character; there is no construction-year cutoff. Silence does not mean false.'),
        property_type: {
          type: ['string', 'null'],
          enum: [...PROPERTY_TYPES, null],
          description:
            'Erdgeschosswohnung=ground_floor_apartment; Dachgeschoss/DG=attic_apartment; Souterrain/Untergeschoss=souterrain; WG-Zimmer=shared_room; 1-Zimmer/Studio=studio; Haus=house; otherwise Wohnung=apartment.',
        },
        condition: {
          type: ['string', 'null'],
          enum: [...CONDITIONS, null],
          description:
            'Erstbezug=first_occupancy; Erstbezug nach Sanierung=first_occupancy_after_renovation; neuwertig=like_new; renoviert=renovated; saniert/modernisiert=refurbished; gepflegt=well_maintained; renovierungsbedürftig=needs_renovation. A dated renovation supports its stated condition, not construction age.',
        },
        furnishing_status: {
          type: 'string',
          enum: FURNISHING_STATUS,
          description:
            'Judge the actual furnishing in context, including conflicts with portal labels: full means the home comes with its furniture, partial means some furnishing, none means unfurnished. A fitted kitchen alone does not make a home fully furnished. Use unknown when unclear.',
        },
        pets_policy: { type: 'string', enum: PETS_POLICIES },
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
                'one — do not derive it from a Warmmiete. Holiday booking prices without a stated monthly rent basis are null, not cold rent.',
            ),
            warm: nullableNumber(
              0,
              50000,
              'Warmmiete, the monthly rent including service charges. Null when the advert does not state one ' +
                '— do not calculate it from other charges or estimate a missing amount. Holiday booking prices without a stated monthly rent basis are null.',
            ),
            deposit: nullableNumber(0, 200000),
          },
        },
        energy_class: { type: ['string', 'null'], enum: [...ENERGY_CLASSES, null] },
        amenities: {
          type: 'array',
          maxItems: AMENITIES.length,
          description:
            'List supported amenities only: true when present, false when the context supports absence. Do not fill out a checklist; omit unstated/unknown amenities. Altbau has its own nullable feature. ' +
            'new_building: judge new construction from the overall advert context, independently of renovation. ' +
            'EBK= fitted_kitchen; Fahrstuhl= elevator; Stellplatz= parking; Tiefgarage= underground_parking; barrierefrei= barrier_free; ' +
            'rollstuhlgerecht= wheelchair_accessible; Gäste-WC= guest_toilet; Keller= cellar; Gartennutzung= garden_use; WG-geeignet= wg_suitable.',
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
            'Cover what matters to a renter: area/location, explicit cold/warm rent, size/rooms, ' +
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
    if (value.available_until && value.lease_duration !== 'fixed')
      errors.push('An explicit tenancy end requires lease_duration=fixed');
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

// Discard only contradictory auxiliary facts; core rent/date errors still retry.
export function clearConflictingOptionalFacts(value) {
  const listing = structuredClone(value);
  const cleared = [];
  const number = (v) => typeof v === 'number' && Number.isFinite(v);
  if (listing && typeof listing === 'object' && !Array.isArray(listing)) {
    if (number(listing.bedrooms) && number(listing.rooms) && listing.bedrooms > listing.rooms) {
      listing.bedrooms = null;
      cleared.push('bedrooms');
    }
    if (number(listing.floor) && number(listing.total_floors) && listing.floor > listing.total_floors) {
      listing.total_floors = null;
      cleared.push('total_floors');
    }
  }
  return { listing, cleared };
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

function validateObject(value, schema, path, errors, root = schema) {
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
    validateValue(value[key], schema.properties[key], `${path}.${key}`, errors, root);
  }
}

function validateValue(value, schema, path, errors, root) {
  if (schema.$ref) schema = root.$defs[schema.$ref.slice('#/$defs/'.length)];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!types.includes(actual)) {
    errors.push(`${path} must be ${types.join(' or ')}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} has an invalid value`);
  if (actual === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} has an invalid format`);
  }
  if (actual === 'number') {
    if (!Number.isFinite(value)) errors.push(`${path} must be finite`);
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }
  if (actual === 'object') validateObject(value, schema, path, errors, root);
  if (actual === 'array') {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path} has too few items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`, errors, root));
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
