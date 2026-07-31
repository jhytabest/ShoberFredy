/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Structured intent filtering.
 *
 * A keyword blacklist is an approximation of a question about the offer: is
 * this a swap, a sublet, a room in a shared flat, furnished, time-limited? The
 * LLM already answers those questions directly — `listing_type`, `lease_type`
 * and `furnishing_status` are validated enum fields on every canonical
 * listing — but nothing consulted them, so the decision kept being
 * made by looking for substrings in whatever text happened to be captured.
 *
 * That indirection is not just imprecise, it is unstable. The same wg-gesucht
 * ad was filtered on one run and passed on the next, purely because the second
 * capture carried a different amount of page text, and each pass that let it
 * through produced another notification. A verdict read from the canonical
 * extraction is the same every time the extraction is.
 *
 * The rules are derived from the blacklist the user already configured, so no
 * reconfiguration is needed: "Tauschwohnung" and "Wohnungsswap" both express
 * "no swaps", and both map onto the same structured predicate. Terms that
 * express something the schema does not model — portal names, for instance —
 * stay with the keyword matcher.
 */

/**
 * Each rule owns the terms that mean it and the predicate that decides it.
 * `matches` runs against the canonical listing's attributes, never against text.
 */
const INTENT_RULES = [
  {
    intent: 'swap',
    label: 'flat swap (Tauschwohnung)',
    term: /tausch|swap/u,
    matches: (a) => a.listingType === 'swap' || a.leaseType === 'swap' || a.swap === true,
  },
  {
    intent: 'wg_room',
    label: 'room in a shared flat',
    term: /^wg$|wohngemeinschaft/u,
    matches: (a) => a.listingType === 'wg_room',
  },
  {
    intent: 'sublet',
    label: 'sublet',
    term: /untermiete|zwischenmiete|sublet/u,
    matches: (a) => a.listingType === 'sublet' || a.leaseType === 'sublet',
  },
  {
    intent: 'furnished',
    label: 'furnished or part-furnished',
    term: /m(ö|o)b|furnish/u,
    // furnishingStatus is the only place furnishing is recorded; the derived
    // `furnished` boolean is a view of it, so testing both proved nothing.
    matches: (a) => a.furnishingStatus === 'full' || a.furnishingStatus === 'partial',
  },
  {
    intent: 'fixed_term',
    label: 'fixed-term lease',
    term: /befristet|auf zeit|temporary|short.?term|kurzzeit/u,
    matches: (a) => a.leaseType === 'fixed',
  },
];

/**
 * Split the configured blacklist into the intents it expresses and the terms
 * that have to stay textual.
 *
 * @param {string[]} blacklist terms as the user wrote them
 * @returns {{intents: object[], unmappedTerms: string[]}}
 */
export function classifyBlacklist(blacklist) {
  const terms = (blacklist || []).filter((term) => typeof term === 'string' && term.trim());
  const intents = new Map();
  const unmappedTerms = [];
  for (const term of terms) {
    const normalized = term.trim().toLocaleLowerCase('de-DE');
    const rule = INTENT_RULES.find((candidate) => candidate.term.test(normalized));
    if (rule) intents.set(rule.intent, rule);
    else unmappedTerms.push(term);
  }
  return { intents: [...intents.values()], unmappedTerms };
}

/**
 * Structured verdict for a canonical listing.
 *
 * Only positively identified intents reject. `unknown` never does: the LLM
 * saying it could not tell is not evidence that the answer is yes, and the
 * keyword matcher still gets its say on the same listing.
 *
 * @param {object} attributes canonical listing attributes
 * @param {string[]} blacklist configured terms
 * @returns {{code: string, stage: string, intent: string, field: string}[]}
 */
export function intentFilterReasons(attributes, blacklist) {
  if (!attributes) return [];
  const { intents } = classifyBlacklist(blacklist);
  const reasons = [];
  for (const rule of intents) {
    if (rule.matches(attributes)) {
      reasons.push({ code: 'intent_filter', stage: 'post_llm', intent: rule.intent, field: 'llm_structured' });
    }
  }
  return reasons;
}

/** Human-readable label for an intent code, for the UI and audit trail. */
export function intentLabel(intent) {
  return INTENT_RULES.find((rule) => rule.intent === intent)?.label || intent;
}
