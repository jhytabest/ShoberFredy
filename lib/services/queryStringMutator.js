/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import queryString from 'query-string';
export default (_url, sortByDateParam) => {
  if (sortByDateParam == null) {
    return _url;
  }
  const original = queryString.parseUrl(_url);
  const mutate = queryString.parse(sortByDateParam);
  return `${original.url}?${queryString.stringify({ ...original.query, ...mutate })}`;
};
