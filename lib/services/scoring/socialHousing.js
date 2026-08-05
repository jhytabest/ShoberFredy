/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export const SOCIAL_LANDLORDS =
  /gewobag|howoge|degewo|gesobau|stadt und land|berlinovo|\bwbm\b|wohnungsbaugesellschaft|kommunale wohnungs|landeseigene/i;

const WBS_MENTION = /wbs|wohnberechtigungsschein/gi;

const WBS_REQUIREMENT =
  /erforderlich|pflicht|zwingend|ben(ö|oe)tigt|notwendig|required|voraussetzung|vorausgesetzt|vorliegen|g(ü|ue)ltig|nur mit|nur ver|nur an/i;

const NEGATION_BEFORE = /\b(kein|keine|keinen|keinem|keiner|ohne|nicht)\b[^.;!?]{0,24}$/i;

const NO_STATEMENT = /keine angaben/i;

const SENTENCE_BOUNDARY = /(?<=[.;!?])\s+/;

function wbsRequiredFrom(text) {
  for (const sentence of text.split(SENTENCE_BOUNDARY)) {
    if (NO_STATEMENT.test(sentence)) continue;
    if (!WBS_REQUIREMENT.test(sentence)) continue;
    for (const match of sentence.matchAll(WBS_MENTION)) {
      if (!NEGATION_BEFORE.test(sentence.slice(0, match.index))) return true;
    }
  }
  return false;
}

export function socialHousingFlags(text) {
  const haystack = String(text ?? '');
  if (!haystack) return { wbsRequired: false, socialLandlord: false };
  return {
    wbsRequired: wbsRequiredFrom(haystack),
    socialLandlord: SOCIAL_LANDLORDS.test(haystack),
  };
}
