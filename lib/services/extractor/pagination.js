/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export function queryPage(url, page, parameter = 'page') {
  const next = new URL(url);
  next.searchParams.set(parameter, String(page));
  return next.toString();
}

export function kleinanzeigenPage(url, page) {
  const next = new URL(url);
  const parts = next.pathname.split('/').filter(Boolean);
  const existing = parts.findIndex((part) => /^seite:\d+$/i.test(part));
  if (existing >= 0) parts[existing] = `seite:${page}`;
  else parts.splice(Math.max(1, parts.length - 1), 0, `seite:${page}`);
  next.pathname = `/${parts.join('/')}`;
  return next.toString();
}
