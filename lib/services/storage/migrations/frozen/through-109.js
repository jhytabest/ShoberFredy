// Immutable migration implementation from revision 57d125c. Do not regenerate.

// lib/services/pipeline/listingFilters.js
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";

// lib/services/pipeline/listingSchema.js
var EXTRACTION_VERSION = 11;
var OFFER_KINDS = ["rental", "swap", "wanted", "sale", "other", "unknown"];
var UNIT_KINDS = ["entire_home", "private_room", "shared_room", "unknown"];
var RENTAL_ARRANGEMENTS = ["direct", "sublet", "unknown"];
var LEASE_DURATIONS = ["indefinite", "fixed", "unstated"];
var AVAILABILITY_TOKENS = ["immediate", "flexible", "unknown"];
var FURNISHING_STATUS = ["full", "partial", "none", "unknown"];
var PETS_POLICIES = ["allowed", "prohibited", "conditional", "preferred_no", "unknown"];
var OFFERED_BY = ["private", "agency", "property_management", "relisting_platform", "unknown"];
var PROPERTY_TYPES = [
  "apartment",
  "ground_floor_apartment",
  "attic_apartment",
  "penthouse",
  "maisonette",
  "loft",
  "studio",
  "souterrain",
  "house",
  "shared_room",
  "other",
  "unknown"
];
var CONDITIONS = [
  "first_occupancy",
  "like_new",
  "renovated",
  "refurbished",
  "first_occupancy_after_renovation",
  "well_maintained",
  "needs_renovation",
  "unknown"
];
var ENERGY_CLASSES = ["A+", "A", "B", "C", "D", "E", "F", "G", "H"];
var AMENITIES = [
  "balcony",
  "terrace",
  "garden",
  "garden_use",
  "elevator",
  "fitted_kitchen",
  "cellar",
  "parking",
  "garage",
  "underground_parking",
  "bathtub",
  "guest_toilet",
  "dishwasher",
  "washing_machine",
  "parquet",
  "underfloor_heating",
  "old_building",
  "new_building",
  "barrier_free",
  "wheelchair_accessible",
  "fireplace",
  "wg_suitable"
];
var CURRENT_YEAR = (/* @__PURE__ */ new Date()).getUTCFullYear();
var listingTool = {
  type: "function",
  function: {
    name: "submit_listing",
    description: "Submit the normalized structured real-estate listing. Use the schema's unknown/unstated value or null for unavailable facts. Everything relevant that does not fit a structured field goes into `comments`.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [
        "title",
        "offer_kind",
        "unit_kind",
        "rental_arrangement",
        "lease_duration",
        "minimum_term_months",
        "address",
        "available_from",
        "available_until",
        "size_sqm",
        "rooms",
        "bedrooms",
        "bathrooms",
        "floor",
        "total_floors",
        "building_year",
        "property_type",
        "condition",
        "furnishing_status",
        "offered_by",
        "rent",
        "energy_class",
        "pets_policy",
        "amenities",
        "comments",
        "summary"
      ],
      properties: {
        title: nullable("string"),
        offer_kind: { type: "string", enum: OFFER_KINDS },
        unit_kind: {
          type: "string",
          enum: UNIT_KINDS,
          description: "The unit actually offered, not the whole flat surrounding a room."
        },
        rental_arrangement: { type: "string", enum: RENTAL_ARRANGEMENTS },
        lease_duration: {
          type: "string",
          enum: LEASE_DURATIONS,
          description: "fixed only for an explicit end or explicitly temporary lease. A minimum stay does not make a lease fixed. unstated when no duration is stated."
        },
        minimum_term_months: nullableNumber(
          0,
          120,
          "Explicit minimum commitment, independently of whether the lease has an end."
        ),
        address: nullable("string", "Most precise address available, ideally street-level."),
        available_from: {
          type: "string",
          pattern: "^(immediate|flexible|unknown|\\d{4}-\\d{2}(-\\d{2})?)$",
          description: 'When the flat becomes available, exactly as the listing states it: "immediate" for sofort/ab sofort, "flexible" for nach Absprache/verhandelbar, "unknown" when the evidence does not say, YYYY-MM-DD when a day is named, or YYYY-MM when only a month is named. Never invent a day.'
        },
        available_until: {
          type: ["string", "null"],
          description: "End of a time-limited offer as YYYY-MM-DD or YYYY-MM; null when the tenancy is open-ended or unstated."
        },
        size_sqm: nullableNumber(1, 2e3),
        rooms: nullableNumber(0.5, 20),
        bedrooms: nullableNumber(0, 15),
        bathrooms: nullableNumber(0, 10),
        floor: nullableNumber(
          -2,
          60,
          "3. OG/Stock/dritter Stock/3 von 5 = 3; EG/Parterre/Hochparterre = 0; UG/Souterrain = -1; DG without a numbered storey = null."
        ),
        total_floors: nullableNumber(1, 80),
        building_year: nullableNumber(
          1200,
          CURRENT_YEAR + 5,
          "Explicit construction year only; never infer a year from location, style, renovation or near-new condition."
        ),
        property_type: {
          type: ["string", "null"],
          enum: [...PROPERTY_TYPES, null],
          description: "Erdgeschosswohnung=ground_floor_apartment; Dachgeschoss/DG=attic_apartment; Souterrain/Untergeschoss=souterrain; WG-Zimmer=shared_room; 1-Zimmer/Studio=studio; Haus=house; otherwise Wohnung=apartment."
        },
        condition: {
          type: ["string", "null"],
          enum: [...CONDITIONS, null],
          description: "Erstbezug=first_occupancy; Erstbezug nach Sanierung=first_occupancy_after_renovation; neuwertig=like_new; renoviert=renovated; saniert/modernisiert=refurbished; gepflegt=well_maintained; renovierungsbed\xFCrftig=needs_renovation. A dated renovation supports its stated condition, not construction age."
        },
        furnishing_status: {
          type: "string",
          enum: FURNISHING_STATUS,
          description: "Judge from context: full means the home comes with its furniture, partial means some furnishing, none means unfurnished. A fitted kitchen alone does not make a home fully furnished. Use unknown when unclear."
        },
        pets_policy: { type: "string", enum: PETS_POLICIES },
        offered_by: {
          type: ["string", "null"],
          enum: [...OFFERED_BY, null],
          description: "Who is advertising: relisting_platform for an intermediary reselling or subletting other people's flats (HousingAnywhere, Spotahome, Wunderflats, Homelike, Nestpick and similar), agency for a Makler, property_management for a Hausverwaltung, private when the landlord or current tenant advertises directly."
        },
        rent: {
          type: "object",
          additionalProperties: false,
          required: ["cold", "warm", "deposit", "mandatory_extras"],
          properties: {
            cold: nullableNumber(
              0,
              5e4,
              "Kaltmiete, the monthly rent before service charges. Null when the advert does not state one \u2014 do not derive it from a Warmmiete."
            ),
            warm: nullableNumber(
              0,
              5e4,
              "Warmmiete, the monthly rent including service charges. Null when the advert does not state one \u2014 do not calculate it from other charges or estimate a missing amount."
            ),
            mandatory_extras: nullableNumber(
              0,
              1e4,
              "Explicit mandatory monthly charges OUTSIDE warm rent. Exclude costs already included in warm rent and optional parking. Do not subtract cold from warm."
            ),
            deposit: nullableNumber(0, 2e5)
          }
        },
        energy_class: { type: ["string", "null"], enum: [...ENERGY_CLASSES, null] },
        amenities: {
          type: "array",
          maxItems: AMENITIES.length,
          description: "Include each supported amenity once: true when present, false when absent based on the advert context. Omit unknown amenities. old_building: judge the building character from the advert context, architecture, description and age; there is no fixed year cutoff. new_building: judge new construction from the overall advert context, independently of renovation. EBK= fitted_kitchen; Fahrstuhl= elevator; Stellplatz= parking; Tiefgarage= underground_parking; barrierefrei= barrier_free; rollstuhlgerecht= wheelchair_accessible; G\xE4ste-WC= guest_toilet; Keller= cellar; Gartennutzung= garden_use; WG-geeignet= wg_suitable.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "present"],
            properties: {
              name: { type: "string", enum: AMENITIES },
              present: { type: "boolean" }
            }
          }
        },
        comments: {
          type: ["string", "null"],
          description: "All remaining relevant facts that do not fit the structured fields, in the original language: application requirements (WBS, Schufa, proof of income, guarantor), swap requirements, WG constraints, notable features outside the amenity vocabulary, the application process, quirks, view, neighbourhood notes, and any contradiction in the advert you could not resolve. Concise plain text. null when nothing remains."
        },
        summary: {
          type: ["string", "null"],
          description: "A 1-3 sentence neutral summary of the listing for a notification, in the original language (German). Cover what matters to a renter: area/location, explicit cold/warm rent, size/rooms, condition and standout features, and any catch (e.g. Tausch only, WBS required, short-term, WG). Factual, no marketing fluff, no invented facts. null only when there is genuinely nothing to say."
        }
      }
    }
  }
};
function validateListing(value) {
  const errors = [];
  validateObject(value, listingTool.function.parameters, "$", errors);
  if (errors.length === 0) {
    if (!isAvailability(value.available_from)) {
      errors.push(`$.available_from must be ${AVAILABILITY_TOKENS.join(", ")}, YYYY-MM-DD, or YYYY-MM`);
    }
    if (value.available_until != null) {
      if (!isIsoDate(value.available_until) && !isIsoMonth(value.available_until)) {
        errors.push("$.available_until must be an ISO date (YYYY-MM-DD) or month (YYYY-MM)");
      } else if (isDateValue(value.available_from) && endsBeforeStart(value.available_from, value.available_until)) {
        errors.push("$.available_until must be >= $.available_from");
      }
    }
    if (value.available_until && value.lease_duration !== "fixed")
      errors.push("An explicit tenancy end requires lease_duration=fixed");
    const { cold, warm } = value.rent;
    if (cold != null && warm != null && warm < cold) errors.push("$.rent.warm must be >= $.rent.cold");
    const amenityNames = value.amenities.map((amenity) => amenity?.name);
    if (new Set(amenityNames).size !== amenityNames.length) {
      errors.push("$.amenities must not name the same amenity twice");
    }
    if (value.bedrooms != null && value.rooms != null && value.bedrooms > value.rooms) {
      errors.push("$.bedrooms must be <= $.rooms");
    }
    if (value.floor != null && value.total_floors != null && value.floor > value.total_floors) {
      errors.push("$.floor must be <= $.total_floors");
    }
    for (const [path, number] of [
      ["$.building_year", value.building_year],
      ["$.total_floors", value.total_floors]
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
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = /* @__PURE__ */ new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function isIsoMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) return false;
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
}
function validateObject(value, schema, path, errors, root = schema) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
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
  if (schema.$ref) schema = root.$defs[schema.$ref.slice("#/$defs/".length)];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (!types.includes(actual)) {
    errors.push(`${path} must be ${types.join(" or ")}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} has an invalid value`);
  if (actual === "string") {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} has an invalid format`);
  }
  if (actual === "number") {
    if (!Number.isFinite(value)) errors.push(`${path} must be finite`);
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }
  if (actual === "object") validateObject(value, schema, path, errors, root);
  if (actual === "array") {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path} has too few items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`, errors, root));
  }
}
function nullable(type, description) {
  const schema = { type: [type, "null"] };
  if (description) schema.description = description;
  return schema;
}
function nullableNumber(minimum, maximum, description) {
  const schema = { type: ["number", "null"], minimum, maximum };
  if (description) schema.description = description;
  return schema;
}

// lib/services/listings/standardizedFacts.js
function normalizeExtraction(value) {
  if (!value || typeof value !== "object") return null;
  const source = value.listing ?? value;
  if (source.offer_kind != null) {
    const listing = structuredClone(source);
    delete listing.evidence;
    return listing;
  }
  if (!source.rent || !("listing_type" in source)) return null;
  const result = Object.fromEntries(
    Object.keys(listingTool.function.parameters.properties).map((key) => [key, source[key] ?? null])
  );
  const type = source.listing_type;
  const lease = source.lease_type;
  result.offer_kind = type === "swap" || lease === "swap" ? "swap" : type === "unknown" ? "unknown" : "rental";
  result.unit_kind = type === "wg_room" || source.property_type === "shared_room" ? "private_room" : type === "rental" || type === "swap" ? "entire_home" : "unknown";
  result.rental_arrangement = type === "sublet" || lease === "sublet" ? "sublet" : "unknown";
  result.lease_duration = source.available_until || lease === "fixed" ? "fixed" : lease === "unlimited" ? "indefinite" : "unstated";
  result.minimum_term_months = null;
  result.rent = { cold: null, warm: null, deposit: null, ...source.rent, mandatory_extras: null };
  result.amenities = source.amenities ?? [];
  result.available_from = source.available_from ?? "unknown";
  return result;
}
function extractionEnvelope(value, provenance = {}) {
  const listing = normalizeExtraction(value);
  if (!listing || !validateListing(listing).valid) return null;
  return {
    schemaVersion: EXTRACTION_VERSION,
    listing,
    provenance: {
      origin: value.provenance?.origin ?? (value.listing?.offer_kind != null || value.offer_kind != null ? "parsed" : "legacy"),
      ...value.provenance,
      ...provenance
    }
  };
}
function attributesFromExtraction(value) {
  const envelope = extractionEnvelope(value);
  if (!envelope) throw new TypeError("Cannot build facts from an invalid extraction");
  const s = envelope.listing;
  const provenance = { ...envelope.provenance };
  delete provenance.input;
  const names = (present) => s.amenities.filter((a) => a.present === present).map((a) => a.name);
  return {
    offerKind: s.offer_kind,
    unitKind: s.unit_kind,
    rentalArrangement: s.rental_arrangement,
    leaseDuration: s.lease_duration,
    minimumTermMonths: s.minimum_term_months,
    coldRentEur: s.rent.cold,
    warmRentEur: s.rent.warm,
    depositEur: s.rent.deposit,
    mandatoryExtrasEur: s.rent.mandatory_extras,
    priceType: s.rent.cold != null ? "cold" : s.rent.warm != null ? "warm" : "unknown",
    floor: s.floor,
    totalFloors: s.total_floors,
    buildingYear: s.building_year,
    propertyType: s.property_type,
    condition: s.condition,
    energyClass: s.energy_class,
    furnishingStatus: s.furnishing_status,
    petsPolicy: s.pets_policy,
    availableFrom: s.available_from,
    availableUntil: s.available_until,
    bedrooms: s.bedrooms,
    bathrooms: s.bathrooms,
    offeredBy: s.offered_by,
    amenities: names(true),
    amenitiesAbsent: names(false),
    comments: s.comments,
    summary: s.summary,
    extraction: { schemaVersion: envelope.schemaVersion, ...provenance }
  };
}

// lib/services/pipeline/listingFilters.js
var DEFAULT_FILTERS = Object.freeze({
  minSize: 60,
  maxColdRent: 2500,
  excludeSwap: true,
  excludeRooms: true,
  excludeSublet: true,
  excludeFixedTerm: true,
  excludeFurnished: true,
  excludeNonAltbau: true,
  spatialFilter: null
});
function intentsImpliedByTerms(terms) {
  const rules = {
    swap: /tausch|swap/u,
    wg_room: /^wg$|wohngemeinschaft/u,
    sublet: /untermiete|zwischenmiete|sublet/u,
    furnished: /m(ö|o)b|furnish/u,
    relisting_platform: /housinganywhere|spotahome|wunderflats|homelike|nestpick/u,
    non_private: /makler|agentur|hausverwaltung|gewerblich|property.?management/u,
    fixed_term: /befristet|auf zeit|temporary|short.?term|kurzzeit/u
  };
  const values = (Array.isArray(terms) ? terms : []).map((v) => String(v).toLocaleLowerCase("de-DE"));
  return Object.entries(rules).filter(([, pattern]) => values.some((v) => pattern.test(v))).map(([intent]) => intent);
}

// lib/shared/markets.js
function normalizeMarket(city) {
  const folded = String(city ?? "").toLocaleLowerCase("de-DE").replace(/ä/gu, "ae").replace(/ö/gu, "oe").replace(/ü/gu, "ue").replace(/ß/gu, "ss").normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  return folded || null;
}

// lib/services/storage/migrations/sql/100.current-schema.js
function up(db) {
  createTables(db);
  dropLegacySurface(db);
  widenToManyCities(db);
  widenBreakerToMarkets(db);
  retirePriceModelState(db);
  createIndexes(db);
  adoptPerJobFilters(db);
  adoptPerJobSchedule(db);
}
function createTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      duration_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      name TEXT,
      -- The city this job searches. It anchors geocoding fallbacks and, folded
      -- to a market key, isolates provider health and listing identity.
      city TEXT,
      -- Free text refused over what a card states, before anything is fetched.
      -- Per job, because the terms were one deployment-wide list only while
      -- every job wanted the same thing; a WG search and a flat search do not.
      blacklist TEXT NOT NULL DEFAULT '[]',
      -- What the job refuses once the model has read the advert, as codes from
      -- a closed vocabulary rather than words guessed at from the page.
      intent_filter TEXT NOT NULL DEFAULT '[]',
      provider TEXT NOT NULL DEFAULT '[]',
      notification_adapter TEXT NOT NULL DEFAULT '[]',
      spatial_filter TEXT,
      spec_filter TEXT,
      last_run_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY,
      create_date INTEGER NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL
    );

    -- Facts the model extracted, and nothing else. What a job decided about them
    -- is a verdict; whether the advert is still offered is 'state'.
    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      created_at INTEGER,
      last_seen_at INTEGER,
      provider TEXT,
      price REAL,
      size REAL,
      rooms REAL,
      title TEXT,
      image_url TEXT,
      address TEXT,
      link TEXT,
      latitude REAL,
      longitude REAL,
      -- Geographic city key resolved from the geocoded locality, so it follows
      -- the flat rather than the search that found it.
      market TEXT,
      state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'gone')),
      state_reason TEXT,
      state_at INTEGER
    );

    -- One row per (listing, job). The config hash and the evidence pair are what
    -- let a later stage ask "already decided, under this configuration, on
    -- evidence that has not moved?" without re-deriving the answer.
    CREATE TABLE IF NOT EXISTS listing_verdicts (
      listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      verdict TEXT NOT NULL CHECK (verdict IN ('accepted', 'rejected')),
      reason TEXT,
      reason_term TEXT,
      stage TEXT NOT NULL CHECK (stage IN ('discovery', 'detail', 'extraction')),
      config_hash TEXT,
      evidence_kind TEXT NOT NULL DEFAULT 'final' CHECK (evidence_kind IN ('card', 'final')),
      evidence_hash TEXT,
      decided_at INTEGER NOT NULL,
      notified_at INTEGER,
      CHECK ((verdict = 'rejected') = (reason IS NOT NULL)),
      PRIMARY KEY (listing_id, job_id)
    ) WITHOUT ROWID;

    -- An advert refused before extraction. Not a listing: there are no canonical
    -- facts behind it, only the card that was refused. Deliberately no job_id \u2014
    -- listing_sources.job_id already scopes it, and deleting a job cascades
    -- through that column for free.
    CREATE TABLE IF NOT EXISTS source_rejections (
      source_id TEXT PRIMARY KEY REFERENCES listing_sources(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      reason_term TEXT,
      stage TEXT NOT NULL CHECK (stage IN ('discovery', 'detail')),
      config_hash TEXT NOT NULL,
      evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('card')),
      evidence_hash TEXT,
      capture_hash TEXT,
      decided_at INTEGER NOT NULL,
      decided_count INTEGER NOT NULL DEFAULT 1,
      last_seen_at INTEGER NOT NULL
    ) WITHOUT ROWID;

    -- A claim is owned by exactly one subject, and a rejection is a subject too.
    -- The claim string stays the primary key because "one claim, one owner" is
    -- what makes a claim an answer rather than a list of candidates.
    CREATE TABLE IF NOT EXISTS listing_claims (
      claim TEXT PRIMARY KEY,
      listing_id TEXT REFERENCES listings(id) ON DELETE CASCADE,
      source_id TEXT REFERENCES listing_sources(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      CHECK ((listing_id IS NULL) <> (source_id IS NULL))
    );

    CREATE TABLE IF NOT EXISTS listing_texts (
      listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
      full_text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      captured_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS listing_attributes (
      listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
      data TEXT NOT NULL DEFAULT '{}',
      schema_version INTEGER NOT NULL DEFAULT 4,
      parsed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS listing_images (
      id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL,
      listing_id TEXT REFERENCES listings(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'photo',
      original_url TEXT,
      storage_path TEXT,
      content_hash TEXT,
      mime_type TEXT,
      byte_size INTEGER,
      width INTEGER,
      height INTEGER,
      download_status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      UNIQUE(queue_id, position)
    );

    CREATE TABLE IF NOT EXISTS listing_extractions (
      queue_id TEXT PRIMARY KEY,
      listing_id TEXT REFERENCES listings(id) ON DELETE CASCADE,
      llm_json TEXT,
      text_model TEXT,
      llm_duration_ms INTEGER,
      parsed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS listing_sources (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      source_key TEXT NOT NULL,
      source_url TEXT NOT NULL,
      detail_queue_id TEXT,
      parsing_queue_id TEXT,
      listing_id TEXT REFERENCES listings(id) ON DELETE SET NULL,
      representative_source_id TEXT REFERENCES listing_sources(id) ON DELETE SET NULL,
      dedupe_stage TEXT,
      dedupe_keys_json TEXT NOT NULL DEFAULT '[]',
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      UNIQUE(job_id, provider, source_key)
    );

    CREATE TABLE IF NOT EXISTS listing_source_observations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES listing_sources(id) ON DELETE CASCADE,
      stage TEXT NOT NULL CHECK(stage IN ('discovery', 'detail')),
      content_hash TEXT NOT NULL,
      content_bytes INTEGER NOT NULL DEFAULT 0,
      observed_at INTEGER NOT NULL,
      UNIQUE(source_id, stage, content_hash)
    );

    CREATE TABLE IF NOT EXISTS pipeline_work (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      -- An exception message, and nothing else. Filter reason codes, policy
      -- sentences and "Waiting: ..." notices used to land here too, which made a
      -- queue of healthy refusals read as a queue of errors.
      last_error TEXT,
      -- What became of the item, split out of status so that column can carry
      -- the lifecycle alone. See lib/services/pipeline/workOutcome.js.
      outcome TEXT,
      outcome_code TEXT,
      outcome_note TEXT,
      -- Parks are bounded: an item waiting on a resource that never arrives is
      -- abandoned rather than re-parked on a timer forever.
      defer_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (kind, key)
    );

    CREATE TABLE IF NOT EXISTS provider_breaker_state (
      provider TEXT PRIMARY KEY,
      -- REAL because the scores decay continuously, computed on read from the
      -- time since the last signal rather than by a background sweep.
      failure_score REAL NOT NULL DEFAULT 0,
      challenge_score REAL NOT NULL DEFAULT 0,
      open_until INTEGER NOT NULL DEFAULT 0,
      last_success_at INTEGER,
      last_signal_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Cadence is per (job, provider), not just per job: two providers on the
    -- same job can be due at different times, and this is what the scheduler
    -- checks due-ness against and persists to, so a restart does not stampede
    -- every pair into running at once.
    CREATE TABLE IF NOT EXISTS job_provider_schedule (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      last_run_at INTEGER,
      PRIMARY KEY (job_id, provider)
    );

    CREATE TABLE IF NOT EXISTS pipeline_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT REFERENCES listing_sources(id) ON DELETE SET NULL,
      listing_id TEXT REFERENCES listings(id) ON DELETE SET NULL,
      queue_id TEXT,
      stage TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      payload_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pipeline_control (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_call_audit (
      id TEXT PRIMARY KEY,
      queue_id TEXT,
      listing_id TEXT REFERENCES listings(id) ON DELETE SET NULL,
      operation TEXT NOT NULL,
      model TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      request_bytes INTEGER NOT NULL,
      response_sha256 TEXT,
      response_bytes INTEGER,
      response_headers_json TEXT,
      usage_json TEXT,
      http_status INTEGER,
      outcome TEXT NOT NULL DEFAULT 'started',
      error TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS llm_budget_usage (
      day INTEGER PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS homeserver_geocode_cache (
      address_key TEXT PRIMARY KEY,
      source_address TEXT NOT NULL,
      status TEXT NOT NULL,
      latitude REAL,
      longitude REAL,
      accuracy TEXT NOT NULL,
      place_id TEXT,
      formatted_address TEXT,
      -- The city Google put the address in, kept so a listing's market is read
      -- off the geocode rather than guessed at from the address text again.
      locality TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

  `);
}
function createIndexes(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at ON schema_migrations(applied_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_enabled ON jobs(enabled);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_name ON settings(name);
    CREATE INDEX IF NOT EXISTS idx_listings_created_at ON listings(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_listings_coordinates ON listings(latitude, longitude);
    CREATE INDEX IF NOT EXISTS idx_listings_link ON listings(link);
    CREATE INDEX IF NOT EXISTS idx_listing_verdicts_job ON listing_verdicts(job_id, verdict, decided_at DESC);
    CREATE INDEX IF NOT EXISTS idx_listing_verdicts_accepted ON listing_verdicts(listing_id) WHERE verdict = 'accepted';
    CREATE INDEX IF NOT EXISTS idx_source_rejections_reason ON source_rejections(reason, decided_at DESC);
    CREATE INDEX IF NOT EXISTS idx_listing_claims_listing ON listing_claims(listing_id);
    CREATE INDEX IF NOT EXISTS idx_listing_claims_source ON listing_claims(source_id);
    CREATE INDEX IF NOT EXISTS idx_listing_texts_hash ON listing_texts(content_hash);
    CREATE INDEX IF NOT EXISTS idx_listing_images_listing ON listing_images(listing_id, position);
    CREATE INDEX IF NOT EXISTS idx_listing_images_hash ON listing_images(content_hash);
    CREATE INDEX IF NOT EXISTS idx_listing_extractions_listing ON listing_extractions(listing_id);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_url ON listing_sources(job_id, source_url);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_detail ON listing_sources(detail_queue_id);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_parsing ON listing_sources(parsing_queue_id);
    CREATE INDEX IF NOT EXISTS idx_listing_sources_listing ON listing_sources(listing_id);
    CREATE INDEX IF NOT EXISTS idx_listing_source_observations_source
      ON listing_source_observations(source_id, stage, observed_at);
    CREATE INDEX IF NOT EXISTS idx_pipeline_work_claim ON pipeline_work(kind, status, next_attempt_at, lease_until);
    CREATE INDEX IF NOT EXISTS idx_pipeline_audit_source ON pipeline_audit_events(source_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pipeline_audit_listing ON pipeline_audit_events(listing_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_call_audit_queue ON llm_call_audit(queue_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_llm_call_audit_listing ON llm_call_audit(listing_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_llm_call_audit_outcome ON llm_call_audit(outcome, started_at);
  `);
}
function widenToManyCities(db) {
  const jobsCityIsNew = !columnExists(db, "jobs", "city");
  const listingsMarketIsNew = !columnExists(db, "listings", "market");
  for (const [table, column, definition] of [
    ["jobs", "city", "TEXT"],
    ["jobs", "blacklist", `TEXT NOT NULL DEFAULT '[]'`],
    ["jobs", "intent_filter", `TEXT NOT NULL DEFAULT '[]'`],
    ["listings", "market", "TEXT"],
    ["homeserver_geocode_cache", "locality", "TEXT"]
  ]) {
    if (!columnExists(db, table, column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  }
  if (jobsCityIsNew) {
    db.prepare(`UPDATE jobs SET city = ? WHERE city IS NULL OR trim(city) = ''`).run(FOUNDING_CITY);
  }
  if (listingsMarketIsNew) {
    db.prepare(`UPDATE listings SET market = ? WHERE market IS NULL OR trim(market) = ''`).run(
      normalizeMarket(FOUNDING_CITY)
    );
  }
}
function retirePriceModelState(db) {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO pipeline_work (
       kind, key, payload_json, status, attempt_count, lease_until, next_attempt_at,
       last_error, outcome, outcome_code, outcome_note, defer_count, created_at, updated_at
     )
     SELECT 'notify', work.key,
            json_object(
              'listingId', work.key,
              'jobId', json_extract(work.payload_json, '$.jobId'),
              'provider', json_extract(work.payload_json, '$.provider')
            ),
            'pending', 0, NULL, 0, NULL, NULL, NULL, NULL, 0, work.created_at, @now
     FROM pipeline_work work
     WHERE work.kind = 'rate'
       AND work.status IN ('pending', 'processing', 'retry', 'deferred')
       AND coalesce(json_extract(work.payload_json, '$.notify'), 0) = 1
       AND EXISTS (
         SELECT 1 FROM jobs job
         WHERE job.id = json_extract(work.payload_json, '$.jobId')
       )
       AND EXISTS (
         SELECT 1 FROM listings listing
         WHERE listing.id = work.key AND listing.state = 'active'
       )
       AND EXISTS (
         SELECT 1 FROM listing_verdicts verdict
         WHERE verdict.listing_id = work.key AND verdict.verdict = 'accepted'
       )
       AND NOT EXISTS (
         SELECT 1 FROM listing_verdicts verdict
         WHERE verdict.listing_id = work.key AND verdict.notified_at IS NOT NULL
       )`
  ).run({ now });
  db.prepare(
    `UPDATE pipeline_work
     SET status = 'cancelled', lease_until = NULL, next_attempt_at = 0, last_error = NULL,
         outcome = 'superseded', outcome_code = 'superseded',
         outcome_note = 'Price-model work retired', updated_at = @now
     WHERE kind IN ('rate', 'market-model')
       AND status IN ('pending', 'processing', 'retry', 'deferred')`
  ).run({ now });
  db.exec(`
    DROP TABLE IF EXISTS homeserver_listing_model_scores;
    DROP TABLE IF EXISTS homeserver_models;
    DROP TABLE IF EXISTS homeserver_model_runs;
  `);
}
function widenBreakerToMarkets(db) {
  if (!tableExists(db, "provider_breaker_state") || columnExists(db, "provider_breaker_state", "market")) return;
  db.exec(`
    CREATE TABLE provider_breaker_state_rebuilt (
      provider TEXT NOT NULL,
      market TEXT NOT NULL,
      failure_score REAL NOT NULL DEFAULT 0,
      challenge_score REAL NOT NULL DEFAULT 0,
      open_until INTEGER NOT NULL DEFAULT 0,
      last_success_at INTEGER,
      last_signal_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, market)
    );
    INSERT INTO provider_breaker_state_rebuilt
      (provider, market, failure_score, challenge_score, open_until, last_success_at, last_signal_at, updated_at)
      SELECT provider, '${FOUNDING_MARKET}', failure_score, challenge_score, open_until, last_success_at, last_signal_at, updated_at
      FROM provider_breaker_state;
    DROP TABLE provider_breaker_state;
    ALTER TABLE provider_breaker_state_rebuilt RENAME TO provider_breaker_state;
  `);
}
var FOUNDING_MARKET = "berlin";
var FOUNDING_CITY = "Berlin";
var DEFAULT_INTERVAL_MINUTES = 15;
function adoptPerJobFilters(db) {
  const settingRow = db.prepare(`SELECT value FROM settings WHERE name = 'blacklist'`).get();
  if (!settingRow) return;
  let terms;
  try {
    terms = JSON.parse(settingRow.value);
  } catch {
    terms = [];
  }
  if (!Array.isArray(terms)) terms = [];
  const inherited = db.prepare(`SELECT id FROM jobs WHERE blacklist = '[]' AND intent_filter = '[]'`).all();
  const update = db.prepare(`UPDATE jobs SET blacklist = @blacklist, intent_filter = @intents WHERE id = @id`);
  const blacklist = JSON.stringify(terms);
  const intents = JSON.stringify(intentsImpliedByTerms(terms));
  for (const job of inherited) update.run({ id: job.id, blacklist, intents });
  db.prepare(`DELETE FROM settings WHERE name = 'blacklist'`).run();
}
function dropLegacySurface(db) {
  if (columnExists(db, "jobs", "user_id")) {
    db.exec(`
      CREATE TABLE jobs_rebuilt (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        name TEXT,
        provider TEXT NOT NULL DEFAULT '[]',
        notification_adapter TEXT NOT NULL DEFAULT '[]',
        spatial_filter TEXT,
        spec_filter TEXT,
        last_run_at INTEGER
      );
      INSERT INTO jobs_rebuilt (id, enabled, name, provider, notification_adapter, spatial_filter, spec_filter, last_run_at)
        SELECT id, enabled, name, provider, notification_adapter, spatial_filter, spec_filter, last_run_at FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_rebuilt RENAME TO jobs;
      CREATE INDEX IF NOT EXISTS idx_jobs_enabled ON jobs(enabled);
    `);
  }
  if (columnExists(db, "settings", "user_id")) {
    db.exec(`
      DELETE FROM settings WHERE user_id IS NOT NULL;
      DROP INDEX IF EXISTS idx_settings_name_user_id;
      ALTER TABLE settings DROP COLUMN user_id;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_name ON settings(name);
    `);
  }
  db.exec(`DROP TABLE IF EXISTS users;`);
  db.exec(`DROP TABLE IF EXISTS homeserver_market_surface_cells;`);
  db.prepare(
    `DELETE FROM settings WHERE name IN
       ('analyticsEnabled', 'demoMode', 'baseUrl', 'sessionTTL', 'session_secret', 'proxyUrl')`
  ).run();
  if (tableExists(db, "pipeline_control")) {
    db.prepare(
      `DELETE FROM pipeline_control
       WHERE name LIKE 'backfill\\_%' ESCAPE '\\' OR name = 'repriced_unpriced_listings'`
    ).run();
  }
}
function adoptPerJobSchedule(db) {
  const intervalIsNew = !columnExists(db, "jobs", "interval");
  const workingHoursIsNew = !columnExists(db, "jobs", "working_hours");
  const notifyIsNew = !columnExists(db, "jobs", "notify");
  for (const [table, column, definition] of [
    ["jobs", "interval", "INTEGER"],
    ["jobs", "working_hours", "TEXT"],
    ["jobs", "notify", "TEXT"]
  ]) {
    if (!columnExists(db, table, column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  }
  if (intervalIsNew || workingHoursIsNew) {
    const settingValue = (name) => {
      const row = db.prepare(`SELECT value FROM settings WHERE name = ?`).get(name);
      if (!row) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    };
    const interval = Number(settingValue("interval"));
    const workingHours = settingValue("workingHours") || { from: "", to: "" };
    db.prepare(`UPDATE jobs SET interval = COALESCE(interval, ?), working_hours = COALESCE(working_hours, ?)`).run(
      Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_MINUTES,
      JSON.stringify(workingHours)
    );
    db.prepare(`DELETE FROM settings WHERE name IN ('interval', 'workingHours', 'port')`).run();
  }
  if (notifyIsNew) {
    const jobs = db.prepare(`SELECT id, notification_adapter FROM jobs`).all();
    const update = db.prepare(`UPDATE jobs SET notify = ? WHERE id = ?`);
    for (const job of jobs) {
      let adapters;
      try {
        adapters = JSON.parse(job.notification_adapter || "[]");
      } catch {
        adapters = [];
      }
      const telegramFields = (Array.isArray(adapters) ? adapters : []).find(
        (entry) => entry?.id === "telegram"
      )?.fields;
      update.run(
        JSON.stringify({
          token: telegramFields?.token ?? null,
          chatId: telegramFields?.chatId ?? null,
          threadId: telegramFields?.messageThreadId ?? null,
          plainText: Boolean(telegramFields?.plainText)
        }),
        job.id
      );
    }
    if (columnExists(db, "jobs", "notification_adapter")) {
      db.exec(`ALTER TABLE jobs DROP COLUMN notification_adapter;`);
    }
  }
}
function tableExists(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}
function columnExists(db, table, column) {
  return Boolean(db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column));
}

// lib/shared/sqlite.js
function tableExists2(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

// lib/shared/values.js
function unique(values) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const value of values || []) {
    const item = typeof value === "string" ? value.trim() : value;
    if (!item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

// lib/shared/hash.js
import crypto from "node:crypto";
function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

// lib/services/listings/claims.js
function claimsForListing(listing) {
  if (!listing) return [];
  const claims = [];
  const add = (kind, value) => {
    if (value) claims.push({ claim: `${kind}:${value}`, kind });
  };
  const identities = listing.sourceIdentities ?? [];
  const urls = unique([listing.link, ...listing.sourceUrls ?? [], ...identities.map((i) => i.sourceUrl)]);
  for (const url of unique(urls.map(canonicalUrl))) add("url", url);
  for (const id of unique(urls.map(providerListingIdentity))) add("pid", id);
  for (const i of identities) if (i.provider && i.sourceKey) add("src", `${i.provider}:${i.sourceKey}`);
  for (const hash of unique(listing.imageHashes ?? [])) add("img", hash);
  return dedupeClaims(claims);
}
function recordClaims(db, listingId, claims, now = Date.now()) {
  if (!listingId || !claims?.length || !tableExists2(db, "listing_claims")) return 0;
  const insert = db.prepare(
    `INSERT INTO listing_claims (claim, listing_id, source_id, kind, first_seen_at)
     VALUES (?, ?, NULL, ?, ?)
     ON CONFLICT(claim) DO UPDATE SET listing_id = excluded.listing_id, source_id = NULL
     WHERE listing_claims.listing_id IS NULL`
  );
  let inserted = 0;
  for (const { claim, kind } of dedupeClaims(claims)) {
    inserted += insert.run(claim, listingId, kind, now).changes;
  }
  return inserted;
}
function addressTokenKey(value) {
  const tokens = String(value || "").toLocaleLowerCase("de-DE").replace(/ß/gu, "ss").split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1 || /^\d$/u.test(token));
  return [...new Set(tokens)].sort().join(" ");
}
function addressesCompatible(left, right) {
  if (houseNumberConflict(left, right)) return false;
  const a = new Set(addressTokenKey(left).split(" ").filter(Boolean));
  const b = new Set(addressTokenKey(right).split(" ").filter(Boolean));
  if (a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) if (!large.has(token)) return false;
  return true;
}
function houseNumbers(value) {
  const found = String(value || "").match(/\b\d{1,4}\s?[a-zA-Z]?\b/gu) || [];
  return new Set(found.map((token) => token.replace(/\s+/gu, "").toLowerCase()).filter(Boolean));
}
function houseNumberConflict(left, right) {
  const a = houseNumbers(left);
  const b = houseNumbers(right);
  if (a.size === 0 || b.size === 0) return false;
  for (const token of a) if (b.has(token)) return false;
  return true;
}
function canonicalUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.hash = "";
    if (/^(?:www\.)?wg-gesucht\.de$/iu.test(url.hostname)) {
      const assetId = url.searchParams.get("asset_id") || url.pathname.match(/\.(\d{5,})\.html$/u)?.[1];
      if (assetId && url.searchParams.has("asset_id")) {
        url.search = "";
        url.searchParams.set("asset_id", assetId);
        return url.toString().replace(/\/$/, "");
      }
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|ref|referrer|tracking|trackingId)$/iu.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(value).trim();
  }
}
function providerListingIdentity(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const path = url.pathname;
    if (/(?:^|\.)immobilienscout24\.de$/u.test(host)) {
      const id = path.match(/\/expose\/(\d{6,})(?:\/|$)/u)?.[1];
      if (id) return `immoscout:${id}`;
    }
    if (/(?:^|\.)wg-gesucht\.de$/u.test(host)) {
      const id = url.searchParams.get("asset_id") || path.match(/\.(\d{5,})\.html$/u)?.[1];
      if (id) return `wgGesucht:${id}`;
    }
    if (/(?:^|\.)kleinanzeigen\.de$/u.test(host)) {
      const id = path.match(/\/(\d+)-\d+-\d+(?:\/|$)/u)?.[1];
      if (id) return `kleinanzeigen:${id}`;
    }
  } catch {
  }
  return null;
}
function sourceKeyFor(provider, externalId, sourceUrl) {
  const identity = providerListingIdentity(sourceUrl);
  if (identity?.startsWith(`${provider}:`)) return identity.slice(provider.length + 1);
  let declared = String(externalId ?? "").trim();
  if (declared.startsWith(`${provider}:`)) declared = declared.slice(provider.length + 1);
  if (provider === "kleinanzeigen" && /^\d+-\d+-\d+$/u.test(declared)) declared = declared.split("-")[0];
  return declared && !/^https?:\/\//iu.test(declared) ? declared : canonicalUrl(sourceUrl);
}
function dedupeClaims(claims) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const entry of claims) {
    if (!entry?.claim || seen.has(entry.claim)) continue;
    seen.add(entry.claim);
    out.push({ claim: entry.claim, kind: entry.kind });
  }
  return out;
}

// lib/services/storage/migrations/sql/101.archive-and-event-history.js
function up2(db) {
  const now = Date.now();
  db.exec(`
    CREATE TABLE runtime_events (
      id INTEGER PRIMARY KEY, severity TEXT NOT NULL, event TEXT NOT NULL,
      message TEXT NOT NULL, payload_json TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_runtime_events_time ON runtime_events(created_at);
    CREATE INDEX idx_runtime_events_event ON runtime_events(event, created_at);
    CREATE TABLE discovery_run_audit (
      id INTEGER PRIMARY KEY, job_id TEXT, provider TEXT NOT NULL, source_url TEXT,
      outcome TEXT NOT NULL, listing_count INTEGER, finished_at INTEGER NOT NULL
    );
    CREATE INDEX idx_discovery_run_job_time ON discovery_run_audit(job_id, provider, finished_at);
    CREATE TABLE geocode_call_audit (
      id INTEGER PRIMARY KEY, address_key TEXT NOT NULL, source_address TEXT NOT NULL,
      candidate_json TEXT NOT NULL, queue_id TEXT, listing_id TEXT, http_status INTEGER, provider_status TEXT,
      result_json TEXT, error TEXT, started_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE INDEX idx_geocode_call_address ON geocode_call_audit(address_key, started_at);
    CREATE TABLE notification_suppressions (
      listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      reason TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(listing_id, job_id)
    );
    CREATE TABLE notification_receipts (
      delivery_key TEXT NOT NULL, target_chat_id TEXT NOT NULL,
      listing_id TEXT NOT NULL, job_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      message_id INTEGER NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY(delivery_key, target_chat_id)
    );
    CREATE INDEX idx_notification_receipts_listing ON notification_receipts(listing_id, job_id);
    CREATE TABLE source_identity_keys (
      identity_key TEXT NOT NULL,
      source_id TEXT NOT NULL REFERENCES listing_sources(id) ON DELETE CASCADE,
      PRIMARY KEY(identity_key, source_id)
    );
    CREATE INDEX idx_source_identity_source ON source_identity_keys(source_id);
    ALTER TABLE llm_call_audit ADD COLUMN validation_status TEXT;
    ALTER TABLE llm_call_audit ADD COLUMN validation_errors_json TEXT;
    ALTER TABLE llm_call_audit ADD COLUMN request_json TEXT;
    ALTER TABLE llm_call_audit ADD COLUMN response_json TEXT;
  `);
  for (const table of ["jobs", "settings"]) {
    const identity = table === "jobs" ? "id" : "name";
    for (const [operation, row] of [
      ["INSERT", "NEW"],
      ["UPDATE", "NEW"],
      ["DELETE", "OLD"]
    ]) {
      db.exec(`CREATE TRIGGER audit_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
        BEGIN
          INSERT INTO runtime_events (severity, event, message, payload_json, created_at)
          VALUES ('info', '${table}_${operation.toLowerCase()}', CAST(${row}.${identity} AS TEXT),
            json_object('table', '${table}', 'operation', '${operation}', 'id', ${row}.${identity}),
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
        END`);
    }
  }
  db.prepare(
    `INSERT INTO pipeline_audit_events (listing_id, stage, action, reason, payload_json, created_at)
    SELECT id, 'migration', 'availability_archived', state_reason,
      json_object('state', state, 'stateAt', state_at, 'lastSeenAt', last_seen_at), ? FROM listings`
  ).run(now);
  db.prepare(
    `INSERT OR IGNORE INTO notification_suppressions
    SELECT l.id, owned.job_id, 'historical_availability_retired', ?
    FROM listings l JOIN (
      SELECT listing_id, job_id FROM listing_verdicts
      UNION SELECT listing_id, job_id FROM listing_sources WHERE listing_id IS NOT NULL
    ) owned ON owned.listing_id = l.id JOIN jobs j ON j.id = owned.job_id
    WHERE l.state = 'gone'`
  ).run(now);
  const unverified = db.prepare(
    `SELECT v.listing_id, v.job_id, v.notified_at FROM listing_verdicts v
    WHERE v.notified_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pipeline_work w WHERE w.kind = 'notify' AND w.status = 'done'
        AND w.outcome = 'sent' AND json_extract(w.payload_json, '$.jobId') = v.job_id
        AND COALESCE(json_extract(w.payload_json, '$.listingId'), w.key) = v.listing_id
    )`
  ).all();
  for (const row of unverified) {
    db.prepare(`INSERT OR IGNORE INTO notification_suppressions VALUES (?, ?, 'legacy_delivery_unverified', ?)`).run(
      row.listing_id,
      row.job_id,
      row.notified_at
    );
    db.prepare(
      `INSERT INTO pipeline_audit_events (listing_id, stage, action, reason, payload_json, created_at)
      VALUES (?, 'migration', 'notification_suppressed', 'legacy_delivery_unverified', ?, ?)`
    ).run(row.listing_id, JSON.stringify({ jobId: row.job_id, previousNotifiedAt: row.notified_at }), now);
    db.prepare("UPDATE listing_verdicts SET notified_at = NULL WHERE listing_id = ? AND job_id = ?").run(
      row.listing_id,
      row.job_id
    );
  }
  db.prepare(
    `INSERT INTO pipeline_audit_events (queue_id, stage, action, reason, created_at)
    SELECT key, 'migration', 'cancelled', 'Listing availability checks retired', ?
    FROM pipeline_work WHERE kind = 'liveness' AND status IN ('pending','processing','retry','deferred')`
  ).run(now);
  db.prepare(
    `UPDATE pipeline_work SET status = 'cancelled', outcome = 'cancelled',
      outcome_note = 'Listing availability checks retired', lease_until = NULL, updated_at = ?
    WHERE kind = 'liveness' AND status IN ('pending','processing','retry','deferred')`
  ).run(now);
  db.prepare(
    `INSERT INTO pipeline_audit_events (queue_id, stage, action, reason, created_at)
    SELECT w.key, 'migration', 'cancelled', 'Historical notification suppressed', ? FROM pipeline_work w
    WHERE w.kind = 'notify' AND w.status IN ('pending','processing','retry','deferred') AND EXISTS (
      SELECT 1 FROM notification_suppressions s
      WHERE s.listing_id = COALESCE(json_extract(w.payload_json, '$.listingId'), w.key)
        AND s.job_id = json_extract(w.payload_json, '$.jobId'))`
  ).run(now);
  db.prepare(
    `UPDATE pipeline_work AS w SET status = 'cancelled', outcome = 'cancelled',
    outcome_note = 'Historical notification suppressed', lease_until = NULL, updated_at = ?
    WHERE w.kind = 'notify' AND w.status IN ('pending','processing','retry','deferred') AND EXISTS (
      SELECT 1 FROM notification_suppressions s
      WHERE s.listing_id = COALESCE(json_extract(w.payload_json, '$.listingId'), w.key)
        AND s.job_id = json_extract(w.payload_json, '$.jobId'))`
  ).run(now);
  db.exec(`ALTER TABLE listings DROP COLUMN state;
    ALTER TABLE listings DROP COLUMN state_reason;
    ALTER TABLE listings DROP COLUMN state_at;`);
  const insertKey = db.prepare("INSERT OR IGNORE INTO source_identity_keys VALUES (?, ?)");
  const selectSources = db.prepare(
    `SELECT rowid AS cursor, id, source_url, dedupe_keys_json
    FROM listing_sources WHERE rowid > ? ORDER BY rowid LIMIT 500`
  );
  let sourceCursor = 0;
  while (true) {
    const sources = selectSources.all(sourceCursor);
    if (sources.length === 0) break;
    for (const source of sources) {
      const keys = JSON.parse(source.dedupe_keys_json || "[]");
      const url = canonicalUrl(source.source_url);
      if (url) keys.push(`url:${url}`);
      for (const key of new Set(keys)) insertKey.run(key, source.id);
    }
    sourceCursor = sources.at(-1).cursor;
  }
  db.prepare(
    `INSERT INTO runtime_events (severity, event, message, payload_json, created_at)
    SELECT 'info', 'legacy_geocode_cache_retired', address_key,
      json_object('sourceAddress', source_address, 'status', status, 'latitude', latitude,
        'longitude', longitude, 'accuracy', accuracy, 'placeId', place_id,
        'formattedAddress', formatted_address, 'locality', locality, 'error', error,
        'attempts', attempts, 'createdAt', created_at, 'updatedAt', updated_at), ?
    FROM homeserver_geocode_cache WHERE instr(address_key, '::') = 0`
  ).run(now);
  db.exec("DELETE FROM homeserver_geocode_cache WHERE instr(address_key, '::') = 0");
  db.prepare(
    `INSERT INTO runtime_events (severity, event, message, payload_json, created_at)
    SELECT 'info', 'monitoring_snapshot_retired', name, value, ? FROM pipeline_control
    WHERE name = 'data_integrity_verdict' OR name LIKE 'discovery:%'`
  ).run(now);
  db.exec("DELETE FROM pipeline_control WHERE name = 'data_integrity_verdict' OR name LIKE 'discovery:%'");
}

// lib/services/pipeline/openRouterErrors.js
var PERMANENT_ERROR = /json schema|xgrammar|not supported|unsupported|valueerror|invalid.*(schema|request)/i;
var TRANSIENT_ERROR = /degraded.*function|function.*degraded|resourceexhausted|worker local total request limit|temporarily|overloaded|capacity|rate.?limit|try again|timeout|503|502/i;
var TRANSIENT_TYPES = /* @__PURE__ */ new Set([
  "provider_unavailable",
  "provider_overloaded",
  "server",
  "timeout",
  "rate_limit_exceeded"
]);
function classifyOpenRouterError(error, httpStatus) {
  const status = Number(httpStatus);
  const code = Number(error?.code);
  const metadata = error?.metadata;
  const raw = typeof metadata?.raw === "string" ? metadata.raw : JSON.stringify(metadata?.raw ?? "");
  const message = `${error?.message || ""}
${raw}`;
  const outcome = status >= 400 ? "http_error" : "upstream_error";
  if ([401, 402, 403].includes(status) || [401, 402, 403].includes(code)) {
    return { outcome, permanent: true };
  }
  if (TRANSIENT_TYPES.has(metadata?.error_type) || !PERMANENT_ERROR.test(message) && TRANSIENT_ERROR.test(message)) {
    return { outcome: "upstream_capacity", permanent: false };
  }
  return {
    outcome,
    permanent: PERMANENT_ERROR.test(message) || code >= 400 && code < 500 && ![408, 429].includes(code) || status >= 400 && status < 500 && ![408, 429].includes(status)
  };
}

// lib/services/storage/migrations/sql/106.recover-provider-outage-pause.js
function up3(db) {
  const pause = db.prepare("SELECT value, updated_at FROM pipeline_control WHERE name = 'llm_service_pause'").get();
  if (!pause) return;
  const state = JSON.parse(pause.value);
  if (state.until !== 864e13 || !state.reason?.startsWith("OpenRouter configuration failure (")) return;
  const call = db.prepare(
    `SELECT a.http_status, a.error, COALESCE(a.response_json, p.body_json) AS response_json
       FROM llm_call_audit a LEFT JOIN audit_payloads p ON p.sha256 = a.response_payload_sha256
       WHERE a.started_at <= ? ORDER BY a.started_at DESC LIMIT 1`
  ).get(pause.updated_at);
  if (!call) return;
  let payload = null;
  try {
    payload = JSON.parse(call.response_json);
  } catch {
  }
  const classification = classifyOpenRouterError(payload?.error ?? { message: call.error }, call.http_status);
  if (classification.outcome !== "upstream_capacity" || classification.permanent) return;
  db.prepare("DELETE FROM pipeline_control WHERE name = 'llm_service_pause'").run();
}

// lib/services/storage/migrations/sql/107.shared-pipeline.js
import { nanoid } from "nanoid";
function up4(db) {
  const now = Date.now();
  const jobs = db.prepare("SELECT * FROM jobs ORDER BY id").all();
  const notifications = jobs.map((j) => parse(j.notify)).filter((n) => n?.token && n.chatId);
  const notify = notifications[0] ?? {};
  if (notifications.some((n) => n.token !== notify.token || String(n.chatId) !== String(notify.chatId) || (n.threadId ?? null) !== (notify.threadId ?? null)))
    throw new Error("Discovery jobs have conflicting Telegram destinations; consolidate them before migrating");
  const polygons = /* @__PURE__ */ new Map();
  for (const job of jobs) for (const feature of parse(job.spatial_filter)?.features ?? [])
    polygons.set(JSON.stringify(feature.geometry), feature);
  const filters = { ...DEFAULT_FILTERS, spatialFilter: polygons.size ? { type: "FeatureCollection", features: [...polygons.values()] } : null };
  db.exec(`
    CREATE TABLE pipeline_config (id INTEGER PRIMARY KEY CHECK(id=1), filters_json TEXT NOT NULL, notify_json TEXT NOT NULL, cutover_at INTEGER NOT NULL);
    CREATE TABLE listing_decisions (
      listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
      verdict TEXT NOT NULL CHECK(verdict IN ('accepted','rejected')), reasons_json TEXT NOT NULL,
      config_hash TEXT NOT NULL, feature_hash TEXT NOT NULL, decided_at INTEGER NOT NULL
    );
    CREATE TABLE discovery_origins (
      source_id TEXT NOT NULL REFERENCES listing_sources(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL, city TEXT, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      PRIMARY KEY(source_id,job_id)
    );
    ALTER TABLE listings ADD COLUMN geocode_accuracy TEXT;
    ALTER TABLE listings ADD COLUMN representative_queue_id TEXT;
  `);
  db.prepare("INSERT INTO pipeline_config VALUES (1,?,?,?)").run(JSON.stringify(filters), JSON.stringify(notify), now);
  db.prepare(`INSERT INTO pipeline_audit_events (listing_id,stage,action,reason,payload_json,created_at)
    SELECT listing_id,'migration','legacy_job_decision',reason,
      json_object('jobId',job_id,'verdict',verdict,'configHash',config_hash,'evidenceHash',evidence_hash,'decidedAt',decided_at,'notifiedAt',notified_at),?
    FROM listing_verdicts`).run(now);
  db.prepare(`INSERT INTO pipeline_audit_events (source_id,stage,action,reason,payload_json,created_at)
    SELECT source_id,'migration','legacy_card_rejection',reason,json_object('stage',stage,'configHash',config_hash,'decidedAt',decided_at),?
    FROM source_rejections`).run(now);
  db.prepare(`INSERT INTO pipeline_audit_events (listing_id,stage,action,reason,payload_json,created_at)
    SELECT listing_id,'migration','legacy_delivery_suppression',reason,json_object('jobId',job_id),?
    FROM notification_suppressions`).run(now);
  db.exec(`
    DROP TABLE listing_verdicts;
    DROP TABLE source_rejections;
    DROP TABLE notification_suppressions;
    DROP TABLE source_identity_keys;
    DROP INDEX IF EXISTS idx_notify_work_owner;
    CREATE TABLE notification_suppressions (
      listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
      reason TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE notification_receipts_next (
      delivery_key TEXT NOT NULL, listing_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      topic_id INTEGER NOT NULL DEFAULT 0, message_id INTEGER NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY(chat_id,message_id)
    );
  `);
  const insertReceipt = db.prepare("INSERT OR IGNORE INTO notification_receipts_next VALUES (?,?,?,?,?,?)");
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  for (const receipt of db.prepare("SELECT * FROM notification_receipts").all()) {
    const topic = Number(parse(jobById.get(receipt.job_id)?.notify)?.threadId) || 0;
    const chat = BigInt(receipt.chat_id).toString();
    insertReceipt.run(JSON.stringify([receipt.listing_id, chat, topic]), receipt.listing_id, chat, topic, receipt.message_id, receipt.received_at);
  }
  db.exec(`DROP TABLE notification_receipts; ALTER TABLE notification_receipts_next RENAME TO notification_receipts;
    CREATE INDEX idx_notification_receipts_destination ON notification_receipts(listing_id,chat_id,topic_id);
    CREATE INDEX migration_source_identity ON listing_sources(provider,source_key);
    CREATE TEMP TABLE source_map (old_id TEXT PRIMARY KEY,new_id TEXT NOT NULL);
    INSERT INTO source_map SELECT id, FIRST_VALUE(id) OVER (PARTITION BY provider,source_key ORDER BY first_seen_at,id) FROM listing_sources;
    CREATE TABLE listing_sources_next (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, source_key TEXT NOT NULL, source_url TEXT NOT NULL,
      city TEXT, detail_queue_id TEXT, parsing_queue_id TEXT,
      listing_id TEXT REFERENCES listings(id) ON DELETE SET NULL,
      discovery_hash TEXT, extraction_version TEXT, historical INTEGER NOT NULL DEFAULT 0,
      first_seen_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,
      UNIQUE(provider,source_key)
    );
    INSERT INTO listing_sources_next
      SELECT s.id,s.provider,s.source_key,s.source_url,j.city,s.detail_queue_id,
        (SELECT x.parsing_queue_id FROM listing_sources x WHERE x.provider=s.provider AND x.source_key=s.source_key AND x.parsing_queue_id IS NOT NULL ORDER BY x.last_seen_at DESC LIMIT 1),
        (SELECT x.listing_id FROM listing_sources x WHERE x.provider=s.provider AND x.source_key=s.source_key AND x.listing_id IS NOT NULL ORDER BY x.last_seen_at DESC LIMIT 1),
        NULL,NULL,1,
        (SELECT MIN(x.first_seen_at) FROM listing_sources x WHERE x.provider=s.provider AND x.source_key=s.source_key),
        (SELECT MAX(x.last_seen_at) FROM listing_sources x WHERE x.provider=s.provider AND x.source_key=s.source_key)
      FROM listing_sources s LEFT JOIN jobs j ON j.id=s.job_id
      WHERE s.id IN (SELECT DISTINCT new_id FROM source_map);
    INSERT INTO discovery_origins
      SELECT m.new_id,s.job_id,j.city,MIN(s.first_seen_at),MAX(s.last_seen_at)
      FROM listing_sources s JOIN source_map m ON m.old_id=s.id LEFT JOIN jobs j ON j.id=s.job_id
      GROUP BY m.new_id,s.job_id;
    UPDATE OR IGNORE listing_source_observations SET source_id=(SELECT new_id FROM source_map WHERE old_id=source_id)
      WHERE source_id IN (SELECT old_id FROM source_map WHERE old_id!=new_id);
    DELETE FROM listing_source_observations WHERE source_id IN (SELECT old_id FROM source_map WHERE old_id!=new_id);
    UPDATE pipeline_audit_events SET source_id=(SELECT new_id FROM source_map WHERE old_id=source_id)
      WHERE source_id IN (SELECT old_id FROM source_map WHERE old_id!=new_id);
    DELETE FROM listing_claims;
    DROP TABLE listing_sources;
    ALTER TABLE listing_sources_next RENAME TO listing_sources;
    DROP TABLE source_map;
    CREATE INDEX idx_listing_sources_detail ON listing_sources(detail_queue_id);
    CREATE INDEX idx_listing_sources_parsing ON listing_sources(parsing_queue_id);
    CREATE INDEX idx_listing_sources_listing ON listing_sources(listing_id);
    CREATE INDEX idx_listing_sources_url ON listing_sources(source_url);
    CREATE INDEX idx_reusable_extraction ON listing_extractions(
      json_extract(llm_json,'$.provenance.evidenceHash'),json_extract(llm_json,'$.provenance.schemaVersion'),json_extract(llm_json,'$.provenance.promptVersion')
    ) WHERE llm_json IS NOT NULL;
  `);
  const extractions = /* @__PURE__ */ new Map();
  for (const row of db.prepare(`SELECT e.*,json_extract(w.payload_json,'$.provider') provider,json_extract(w.payload_json,'$.sourceKey') source_key
    FROM listing_extractions e JOIN pipeline_work w ON w.kind='parse' AND w.key=e.queue_id
    WHERE e.llm_json IS NOT NULL ORDER BY e.parsed_at DESC`).all()) {
    const key = JSON.stringify([row.provider, row.source_key]);
    if (!extractions.has(key)) extractions.set(key, row);
  }
  const groups = /* @__PURE__ */ new Map();
  for (const source of db.prepare("SELECT * FROM listing_sources WHERE listing_id IS NOT NULL ORDER BY first_seen_at,id").all()) {
    const group = groups.get(source.listing_id) ?? [];
    const extraction = extractions.get(JSON.stringify([source.provider, source.source_key]));
    group.push({ source, extraction, facts: normalizeExtraction(parse(extraction?.llm_json)) });
    groups.set(source.listing_id, group);
  }
  for (const [listingId, group] of groups) {
    const conflicting = group.some((a, i) => group.slice(i + 1).some((b) => contradicts(a.facts, b.facts)));
    if (!conflicting) {
      const queue = group.find((g) => g.extraction)?.extraction.queue_id;
      if (queue) db.prepare("UPDATE listings SET representative_queue_id=? WHERE id=?").run(queue, listingId);
      continue;
    }
    for (const [index, { source, extraction, facts }] of group.entries()) {
      let attributes;
      try {
        attributes = facts && attributesFromExtraction(parse(extraction.llm_json));
      } catch {
        attributes = null;
      }
      if (!attributes) {
        db.prepare("UPDATE listing_sources SET listing_id=NULL WHERE id=?").run(source.id);
        archiveRepair(db, listingId, source.id, null, now);
        continue;
      }
      const id = index === 0 ? listingId : nanoid();
      const image = db.prepare("SELECT original_url FROM listing_images WHERE queue_id=? ORDER BY position LIMIT 1").get(extraction.queue_id)?.original_url ?? null;
      if (id !== listingId) db.prepare(`INSERT INTO listings (id,created_at,last_seen_at,provider,title,link) VALUES (?,?,?,?,?,?)`).run(id, source.first_seen_at, source.last_seen_at, source.provider, facts.title ?? "", source.source_url);
      db.prepare(`UPDATE listings SET provider=?,title=?,link=?,address=?,price=?,size=?,rooms=?,image_url=?,
        latitude=NULL,longitude=NULL,geocode_accuracy=NULL,representative_queue_id=?,market=COALESCE(market,'berlin') WHERE id=?`).run(
        source.provider,
        facts.title ?? "",
        canonicalUrl(source.source_url),
        facts.address,
        facts.rent.cold ?? facts.rent.warm,
        facts.size_sqm,
        facts.rooms,
        image,
        extraction.queue_id,
        id
      );
      db.prepare(`INSERT INTO listing_attributes (listing_id,data,parsed_at) VALUES (?,?,?)
        ON CONFLICT(listing_id) DO UPDATE SET data=excluded.data,parsed_at=excluded.parsed_at`).run(id, JSON.stringify(attributes), extraction.parsed_at);
      db.prepare("UPDATE listing_sources SET listing_id=? WHERE id=?").run(id, source.id);
      db.prepare(`UPDATE listing_extractions SET listing_id=? WHERE queue_id IN (
        SELECT key FROM pipeline_work WHERE kind='parse' AND json_extract(payload_json,'$.provider')=? AND json_extract(payload_json,'$.sourceKey')=?)`).run(id, source.provider, source.source_key);
      db.prepare("UPDATE listing_images SET listing_id=? WHERE queue_id=?").run(id, extraction.queue_id);
      db.prepare("DELETE FROM listing_texts WHERE listing_id=?").run(id);
      const capture = db.prepare(`SELECT p.body_json FROM listing_source_observations o JOIN audit_payloads p ON p.sha256=o.payload_sha256
        WHERE o.source_id=? AND o.stage='detail' ORDER BY o.observed_at DESC LIMIT 1`).get(source.id);
      const text = parse(capture?.body_json)?.fullText;
      if (text) db.prepare("INSERT INTO listing_texts VALUES (?,?,?,?)").run(id, text, extraction.queue_id, now);
      archiveRepair(db, listingId, source.id, id, now);
    }
  }
  db.prepare(`INSERT INTO notification_suppressions SELECT id,'pre_cutover_history',? FROM listings`).run(now);
  db.prepare(`INSERT INTO pipeline_audit_events (queue_id,stage,action,reason,created_at)
    SELECT key,'migration','cancelled','Pre-cutover work retired from the new-only stream',? FROM pipeline_work
    WHERE kind IN ('detail','parse','notify') AND status IN ('pending','processing','retry','deferred')`).run(now);
  db.prepare(`UPDATE pipeline_work SET status='cancelled',lease_until=NULL,outcome='cancelled',outcome_code='already_decided',
    outcome_note='Pre-cutover work retired from the new-only stream',updated_at=?
    WHERE kind IN ('detail','parse','notify') AND status IN ('pending','processing','retry','deferred')`).run(now);
  for (const source of db.prepare("SELECT * FROM listing_sources WHERE listing_id IS NOT NULL").all())
    recordClaims(db, source.listing_id, claimsForListing({ sourceIdentities: [{ provider: source.provider, sourceKey: source.source_key, sourceUrl: source.source_url }] }), now);
  for (const row of db.prepare(`SELECT l.id,i.content_hash FROM listings l JOIN listing_images i ON i.queue_id=l.representative_queue_id WHERE i.content_hash IS NOT NULL`).all())
    recordClaims(db, row.id, [{ kind: "img", claim: `img:${row.content_hash}` }], now);
  for (const column of ["blacklist", "intent_filter", "notify", "spatial_filter", "spec_filter"]) db.exec(`ALTER TABLE jobs DROP COLUMN ${column}`);
  const violations = db.pragma("foreign_key_check");
  if (violations.length) throw new Error(`Shared pipeline migration left ${violations.length} foreign-key violations`);
}
function parse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function contradicts(a, b) {
  if (!a || !b) return false;
  if (a.floor != null && b.floor != null && a.floor !== b.floor) return true;
  if (a.rooms != null && b.rooms != null && Math.abs(a.rooms - b.rooms) > 0.01) return true;
  if (a.size_sqm != null && b.size_sqm != null && Math.abs(a.size_sqm - b.size_sqm) > Math.min(1, Math.max(a.size_sqm, b.size_sqm) * 0.01)) return true;
  return Boolean(a.address && b.address && !addressesCompatible(a.address, b.address));
}
function archiveRepair(db, oldListingId, sourceId, newListingId, now) {
  db.prepare(`INSERT INTO pipeline_audit_events (source_id,listing_id,stage,action,payload_json,created_at) VALUES (?,?,'migration','identity_repaired',?,?)`).run(sourceId, newListingId ?? oldListingId, JSON.stringify({ previousListingId: oldListingId, newListingId, historical: true }), now);
}

// lib/services/storage/migrations/sql/108.repaired-text-fingerprints.js
function up5(db) {
  const rows = db.prepare(`SELECT t.listing_id,t.full_text FROM listing_texts t
    JOIN listings l ON l.id=t.listing_id WHERE t.content_hash=l.representative_queue_id`).all();
  const update = db.prepare("UPDATE listing_texts SET content_hash=? WHERE listing_id=?");
  for (const row of rows) update.run(sha256(row.full_text), row.listing_id);
}

// lib/services/storage/migrations/sql/109.canonical-source-identities.js
function up6(db) {
  const now = Date.now();
  const groups = /* @__PURE__ */ new Map();
  for (const source of db.prepare("SELECT * FROM listing_sources").all()) {
    const key = sourceKeyFor(source.provider, source.source_key, source.source_url);
    const identity = JSON.stringify([source.provider, key]);
    const group = groups.get(identity) ?? { key, sources: [] };
    group.sources.push(source);
    groups.set(identity, group);
  }
  db.exec(`CREATE TEMP TABLE canonical_source_map (
    old_id TEXT PRIMARY KEY,new_id TEXT NOT NULL,provider TEXT NOT NULL,
    old_key TEXT NOT NULL,new_key TEXT NOT NULL,historical INTEGER NOT NULL
  )`);
  const map = db.prepare("INSERT INTO canonical_source_map VALUES (?,?,?,?,?,?)");
  const update = db.prepare(`UPDATE listing_sources SET first_seen_at=?,last_seen_at=?,historical=? WHERE id=?`);
  for (const { key, sources } of groups.values()) {
    sources.sort((a, b) => Number(b.source_key === key) - Number(a.source_key === key) || a.first_seen_at - b.first_seen_at || a.id.localeCompare(b.id));
    const winner = sources[0];
    const historical = Number(sources.some((s) => s.historical));
    update.run(Math.min(...sources.map((s) => s.first_seen_at)), Math.max(...sources.map((s) => s.last_seen_at)), historical, winner.id);
    for (const source of sources) map.run(source.id, winner.id, source.provider, source.source_key, key, historical);
  }
  db.exec(`
    INSERT INTO discovery_origins (source_id,job_id,city,first_seen_at,last_seen_at)
      SELECT m.new_id,o.job_id,MIN(o.city),MIN(o.first_seen_at),MAX(o.last_seen_at)
      FROM discovery_origins o JOIN canonical_source_map m ON m.old_id=o.source_id
      GROUP BY m.new_id,o.job_id
      ON CONFLICT(source_id,job_id) DO UPDATE SET
        first_seen_at=MIN(first_seen_at,excluded.first_seen_at),last_seen_at=MAX(last_seen_at,excluded.last_seen_at);
    DELETE FROM discovery_origins WHERE source_id IN (SELECT old_id FROM canonical_source_map WHERE old_id!=new_id);
    UPDATE OR IGNORE listing_source_observations SET source_id=(SELECT new_id FROM canonical_source_map WHERE old_id=source_id)
      WHERE source_id IN (SELECT old_id FROM canonical_source_map WHERE old_id!=new_id);
    DELETE FROM listing_source_observations WHERE source_id IN (SELECT old_id FROM canonical_source_map WHERE old_id!=new_id);
    UPDATE pipeline_audit_events SET source_id=(SELECT new_id FROM canonical_source_map WHERE old_id=source_id)
      WHERE source_id IN (SELECT old_id FROM canonical_source_map WHERE old_id!=new_id);
  `);
  db.prepare(`INSERT INTO pipeline_audit_events (source_id,listing_id,stage,action,payload_json,created_at)
    SELECT m.new_id,s.listing_id,'migration','source_alias_normalized',
      json_object('oldSourceId',m.old_id,'oldKey',m.old_key,'newKey',m.new_key),?
    FROM canonical_source_map m JOIN listing_sources s ON s.id=m.old_id WHERE m.old_id!=m.new_id OR m.old_key!=m.new_key`).run(now);
  db.exec(`DELETE FROM listing_sources WHERE id IN (SELECT old_id FROM canonical_source_map WHERE old_id!=new_id);
    UPDATE listing_sources SET source_key=(SELECT new_key FROM canonical_source_map WHERE old_id=id);
  `);
  db.prepare(`INSERT OR IGNORE INTO notification_suppressions
    SELECT listing_id,'historical_source_alias',? FROM listing_sources WHERE historical=1 AND listing_id IS NOT NULL`).run(now);
  db.prepare(`INSERT INTO pipeline_audit_events (queue_id,stage,action,reason,created_at)
    SELECT w.key,'migration','cancelled','Historical source alias is outside the new-only stream',?
    FROM pipeline_work w WHERE w.kind IN ('detail','parse','notify') AND w.status IN ('pending','processing','retry','deferred')
      AND (EXISTS (SELECT 1 FROM canonical_source_map m WHERE m.historical=1
        AND m.provider=json_extract(w.payload_json,'$.provider') AND (m.old_key=json_extract(w.payload_json,'$.sourceKey') OR m.new_key=json_extract(w.payload_json,'$.sourceKey')))
        OR (w.kind='notify' AND EXISTS (SELECT 1 FROM notification_suppressions s WHERE s.listing_id=json_extract(w.payload_json,'$.listingId'))))`).run(now);
  db.prepare(`UPDATE pipeline_work AS w SET status='cancelled',lease_until=NULL,outcome='cancelled',outcome_code='already_decided',
    outcome_note='Historical source alias is outside the new-only stream',updated_at=?
    WHERE kind IN ('detail','parse','notify') AND status IN ('pending','processing','retry','deferred')
      AND (EXISTS (SELECT 1 FROM canonical_source_map m WHERE m.historical=1
        AND m.provider=json_extract(w.payload_json,'$.provider') AND (m.old_key=json_extract(w.payload_json,'$.sourceKey') OR m.new_key=json_extract(w.payload_json,'$.sourceKey')))
        OR (kind='notify' AND EXISTS (SELECT 1 FROM notification_suppressions s WHERE s.listing_id=json_extract(w.payload_json,'$.listingId'))))`).run(now);
  db.exec(`DELETE FROM listing_claims WHERE kind IN ('src','pid','url')`);
  for (const source of db.prepare("SELECT * FROM listing_sources WHERE listing_id IS NOT NULL").all())
    recordClaims(db, source.listing_id, claimsForListing({ sourceIdentities: [{ provider: source.provider, sourceKey: source.source_key, sourceUrl: source.source_url }] }), now);
  db.exec("DROP TABLE canonical_source_map");
  if (db.pragma("foreign_key_check").length) throw new Error("Canonical source identity migration left foreign-key violations");
}
export {
  up as migration100,
  up2 as migration101,
  up3 as migration106,
  up4 as migration107,
  up5 as migration108,
  up6 as migration109
};
