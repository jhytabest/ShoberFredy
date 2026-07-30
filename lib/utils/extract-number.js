/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Extract the first number from a string like "1.234 €" or "70 m²".
 *
 * Numbers are read as German: dots group thousands and a comma is the decimal
 * separator, so "1.234,56" is 1234.56.
 *
 * The run must begin with a digit. Callers capture from concatenated card
 * markup where a separator can belong to the preceding text — Kleinanzeigen
 * renders "1.057 €2 Zimmer,68 m²" with no space — and parsing that leading
 * comma as a decimal point turned a 68 m² flat into 0.68 m², which then lost
 * to every minimum-size filter. A separator with no digit in front of it is
 * punctuation, not part of the number.
 *
 * @param {string|undefined|null} str
 * @returns {number|null}
 */
export const extractNumber = (str) => {
  if (str == null) return null;
  if (typeof str === 'number') return Number.isFinite(str) ? str : null;
  const run = String(str).match(/\d[\d.,]*/u);
  if (run == null) return null;
  const cleaned = run[0]
    .replace(/[.,]+$/u, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
};
