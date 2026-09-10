/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export function up(db) {
  db.exec(`
    CREATE INDEX idx_listing_images_stored_path ON listing_images(storage_path) WHERE download_status = 'stored';
    CREATE INDEX idx_notify_work_owner ON pipeline_work(
      json_extract(payload_json, '$.jobId'), COALESCE(json_extract(payload_json, '$.listingId'), key)
    ) WHERE kind = 'notify';
  `);
}
