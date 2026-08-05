/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export const formatListing = (listing) => {
  return {
    ...listing,
    price: listing.price != null ? `${listing.price} €` : null,
    size: listing.size != null ? `${listing.size} m²` : null,
    rooms: listing.rooms != null ? `${listing.rooms} Zimmer` : null,
  };
};
