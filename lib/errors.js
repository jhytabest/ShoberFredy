/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

class ExtendableError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    } else {
      this.stack = new Error(message).stack;
    }
  }
}
class NoNewListingsWarning extends ExtendableError {}
/*
 * Thrown by the pipeline when the geocoder could not be asked (no API key,
 * quota, transport). The run is aborted before save: nothing is stored, the
 * listings are re-scraped on the next run, and the failure is surfaced via
 * the geocoding health gauge in the metrics exporter.
 */
class GeocodingUnavailableError extends ExtendableError {}
export { NoNewListingsWarning, GeocodingUnavailableError };
export default {
  NoNewListingsWarning,
  GeocodingUnavailableError,
};
