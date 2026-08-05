/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
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
