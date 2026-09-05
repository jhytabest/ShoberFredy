/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const BASE64_SHAPE_PATTERN = /^[A-Za-z0-9+/_-]+\.{0,2}$/;

const POLYLINE_PATTERN = /^[\x3f-\x7e]+$/;

const URL_SAFE_ALPHABETS = [
  [
    [/_/g, '+'],
    [/-/g, '/'],
  ],
  [
    [/-/g, '+'],
    [/_/g, '/'],
  ],
  [],
];

export function toPolyline(shape) {
  if (!BASE64_SHAPE_PATTERN.test(shape)) return shape;

  const padded = shape.replace(/\.\./g, '==').replace(/\./g, '=');

  for (const substitutions of URL_SAFE_ALPHABETS) {
    const candidate = substitutions.reduce((value, [from, to]) => value.replace(from, to), padded);
    const decoded = Buffer.from(candidate, 'base64').toString('utf-8');
    if (POLYLINE_PATTERN.test(decoded)) return decoded;
  }

  return shape;
}
