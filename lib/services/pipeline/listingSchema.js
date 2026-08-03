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
 * (free text, original language).
 *
 * One fact is represented in exactly one place, and that is a correctness
 * requirement rather than a matter of taste. Availability used to span an enum,
 * a precision label and two date strings; furnishing spanned a boolean, an enum
 * and two amenity values; amenities spanned two arrays that had to stay
 * disjoint. Every schema violation the parser has ever recorded was a model
 * failing to keep two such fields agreeing — never a fact it could not read.
 * Where the same information is now derivable (a date's precision from its
 * shape, a furnished boolean from its status), it is derived after extraction
 * instead of being asked for twice.
 */

const LISTING_TYPES = ['rental', 'wg_room', 'sublet', 'swap', 'unknown'];
const PRICE_TYPES = ['cold', 'warm', 'unknown'];
/** Non-date answers to "from when": every listing has one of these or a date. */
const AVAILABILITY_TOKENS = ['immediate', 'flexible', 'unknown'];
const FURNISHING_STATUS = ['full', 'partial', 'none', 'unknown'];
const PETS_POLICIES = ['allowed', 'prohibited', 'conditional', 'preferred_no', 'unknown'];
const LEASE_TYPES = ['unlimited', 'fixed', 'sublet', 'swap', 'unknown'];
// Who is actually offering the flat. Added so the last text-matching rule after
// extraction could be deleted: the blacklist carried 'HousingAnywhere' and
// 'Spotahome', which are not properties of the flat at all but of the party
// relisting it, and no structured field expressed that.
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
/**
 * An amenity earns a place here by being read: either it is a market-model
 * feature or it is rendered to the reader in German. Fourteen values were
 * neither — shower, floorboards, tiles, high_ceilings, stucco, storage_room,
 * bicycle_room, attic, air_conditioning, smart_home, pool, sauna, concierge,
 * washing_machine_connection — so the model was asked to decide them, the
 * decoder to constrain them and the deduplicator to clean them, for a value no
 * code ever read. A sauna worth mentioning is worth a sentence in `comments`,
 * which is what that field is for.
 *
 * No 'furnished'/'partially_furnished'/'pets_welcome': furnishing_status and
 * pets_policy own those facts. Offering them here too is what let one listing
 * claim to be furnished and unfurnished at once.
 */
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
      // Every field is required, because a field the model may omit is a field
      // it omits. `lease_type` came back 'unknown' on 76% of extractions and
      // `offered_by` was simply absent on 73% while both were optional, and two
      // of the six post-extraction filter rules read nothing else. Required does
      // not mean answerable: the value may still be null or 'unknown'.
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
        // One field answers "from when", in whichever form the listing states
        // it. The shape of the value carries its own precision, so nothing has
        // to label it, and a stated date can never be contradicted by a
        // separate enum that says the flat is available immediately.
        //
        // The pattern is what the decoder can enforce; `validateListing` checks
        // the same shape afterwards because a pattern cannot reject 2026-02-31.
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
        // The single most consequential field in the schema: furnishing decides
        // 93% of everything the post-extraction filters reject, and it carried no
        // description at all while `offered_by` — which has ever decided five
        // listings — had three lines of one.
        furnishing_status: {
          type: 'string',
          enum: FURNISHING_STATUS,
          description:
            'full = vollmöbliert, the flat comes with its furniture. partial = teilmöbliert, some fitted or left ' +
            'items such as an Einbauküche or built-in wardrobes but not a furnished home. none = unmöbliert, ' +
            'including a flat with only an Einbauküche mentioned as an amenity. unknown when the advert does not say.',
        },
        pets_policy: { type: 'string', enum: PETS_POLICIES },
        // Nullable, and only because of history: extractions stored before these
        // two fields existed are migrated in place rather than re-bought, and
        // `offered_by` is unrecoverable for 70% of them. null means "never
        // extracted"; 'unknown' means the model read the advert and could not
        // tell. Nothing branches on the difference — both are "no positive
        // identification" to every filter — but conflating them would have thrown
        // away the only record of which rows predate the field.
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
          required: ['cold', 'warm', 'service_charges', 'heating_costs', 'deposit', 'price_type'],
          properties: {
            // Both figures, whenever the advert supports both. Everything
            // downstream is priced on a cold basis, so an advert that states a
            // Warmmiete and its Nebenkosten separately holds a Kaltmiete the
            // model can state — and one that states only a warm figure cannot be
            // put on that basis at all without inventing a ratio.
            cold: nullableNumber(
              0,
              50000,
              'Kaltmiete, the rent before service charges. State it whenever the advert gives it ' +
                'directly, or gives a Warmmiete together with the Nebenkosten to subtract from it. ' +
                'Null only when neither is available.',
            ),
            warm: nullableNumber(
              0,
              50000,
              'Warmmiete, the rent including service charges. State it whenever the advert gives it ' +
                'directly, or gives a Kaltmiete together with the Nebenkosten to add to it.',
            ),
            service_charges: nullableNumber(
              0,
              10000,
              'Nebenkosten per month, excluding heating when stated apart. State it whenever the advert ' +
                'names it at all — it is what makes a Warmmiete convertible to a Kaltmiete, and without it ' +
                'an advert quoting only warm cannot be compared with the rest.',
            ),
            heating_costs: nullableNumber(0, 10000, 'Heizkosten per month, only when quoted separately.'),
            deposit: nullableNumber(0, 200000),
            price_type: {
              type: 'string',
              enum: PRICE_TYPES,
              description: 'Which of the two figures the advert quotes as its headline price.',
            },
          },
        },
        // Was an `energy` object of three fields, of which two were read by
        // nothing: `heating_type` carried a ten-value enum and its own glossary
        // line, and `value_kwh` reached the scorer's listing shape without any
        // model term ever reading it. One surviving field does not need a wrapper.
        energy_class: { type: ['string', 'null'], enum: [...ENERGY_CLASSES, null] },
        // Presence and absence in one list. As two disjoint arrays this was the
        // only place in the schema where a correct answer required the model to
        // compare two fields it had written independently.
        //
        // `maxItems` bounds what was the parser's dominant failure: unconstrained,
        // greedy decoding regularly emitted one value ten times over — 303 of 400
        // extractions once needed `rent.included` deduplicated — which is most of
        // why a successful extraction averaged 2853 completion tokens against a
        // 120-second deadline. A vocabulary-length cap cannot be exceeded by a
        // correct answer, so it truncates only a runaway. `uniqueItems` would say
        // it exactly and cannot be used: xgrammar, the constrained decoder behind
        // the free NVIDIA endpoint, refuses to compile a schema containing it and
        // rejects every request outright. This is now the last array in the
        // schema, and the only reason the deduplicating normalizer still exists.
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
        // The catch-all, and the reason the schema can afford to be this small.
        // Everything worth knowing that no field holds — a WBS requirement, a
        // sauna, an application deadline, a stated contradiction — belongs here
        // as prose rather than as another vocabulary to constrain and clean.
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

/**
 * Validate an LLM extraction against the schema: structure, enums, and numeric
 * ranges, plus the handful of relationships JSON schema cannot express.
 *
 * What is deliberately absent here is as important as what remains. Every rule
 * that existed only to keep two fields describing one fact in agreement is gone,
 * because the second field is gone: availability against its date and precision
 * label, `furnished` against `furnishing_status`, `pets_allowed` against
 * `pets_policy`, `amenities` against `amenities_absent`. What is left are
 * genuine relationships between different facts — a warm rent that cannot be
 * below the cold rent it contains, bedrooms that cannot outnumber rooms — which
 * are worth a retry because they mean the extraction is actually wrong.
 *
 * @param {object} value candidate tool-call arguments
 * @returns {{valid: boolean, errors: string[]}}
 */
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
    const { cold, warm, service_charges: serviceCharges, heating_costs: heatingCosts } = value.rent;
    if (cold != null && warm != null && warm < cold) errors.push('$.rent.warm must be >= $.rent.cold');
    if (warm != null && serviceCharges != null && heatingCosts != null && serviceCharges + heatingCosts > warm) {
      errors.push('$.rent charges must not exceed $.rent.warm');
    }
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

/** Whether `available_from` carries a date rather than one of the tokens. */
function isDateValue(value) {
  return isIsoDate(value) || isIsoMonth(value);
}

function isAvailability(value) {
  return AVAILABILITY_TOKENS.includes(value) || isDateValue(value);
}

/**
 * Whether the tenancy ends before it starts, comparing bounds of mixed
 * precision on their common part. As plain strings 'YYYY-MM' sorts before every
 * day inside that month, so a month-precision end would look earlier than a
 * day-precision start in the very same month.
 */
function endsBeforeStart(from, until) {
  const monthOnly = isIsoMonth(from) || isIsoMonth(until);
  return (monthOnly ? until.slice(0, 7) : until) < (monthOnly ? from.slice(0, 7) : from);
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
