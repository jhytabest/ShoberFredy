/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import SqliteConnection from './SqliteConnection.js';
import { saveListingText } from './listingTextStorage.js';
import { nanoid } from 'nanoid';
import { upsertListingAttributes } from '../listings/attributes.js';

export const storeListings = (providerId, listings) => {
  if (!Array.isArray(listings) || listings.length === 0) {
    return [];
  }

  const storedIds = [];
  SqliteConnection.withTransaction((db) => {
    const stmt = db.prepare(
      `INSERT INTO listings (id, provider, price, size, rooms, title, image_url, address,
                             link, created_at, last_seen_at, latitude, longitude, market, state)
       VALUES (@id, @provider, @price, @size, @rooms, @title, @image_url, @address, @link,
               @created_at, @last_seen_at, @latitude, @longitude, @market, 'active')`,
    );
    for (const item of listings) {
      const now = Date.now();
      const params = {
        id: nanoid(),
        provider: providerId,
        price: item.price,
        size: item.size,
        rooms: item.rooms,
        title: item.title,
        image_url: item.image,
        address: item.address ?? null,
        link: item.link,
        created_at: item.created_at ?? now,
        last_seen_at: now,
        latitude: item.latitude || null,
        longitude: item.longitude || null,
        market: item.market ?? null,
      };
      stmt.run(params);
      item.id = params.id;
      storedIds.push(params.id);
      saveListingText(params.id, item.fullText, item.created_at ?? Date.now(), db);

      if (item.attributes) upsertListingAttributes(db, params.id, item.attributes);
    }
  });

  return storedIds;
};
