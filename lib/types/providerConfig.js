/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/** @import { ParsedListing } from './listing.js' */

/**
 * @typedef {Object} ProviderConfig
 * @property {string} [url] Base URL to crawl.
 * @property {string} [sortByDateParam] Query parameter used to enforce sorting by date.
 * @property {string} [waitForSelector] CSS selector to wait for before parsing content.
 * @property {Object.<string, string>} crawlFields Mapping of field names to selectors/paths.
 * @property {string[]} requiredFieldNames List of field names that this provider supports.
 * @property {string} [crawlContainer] CSS selector for the container holding listing items.
 * @property {{urlForPage:(url:string,page:number)=>string,maxPages?:number}} [pagination] Provider pagination strategy.
 * @property {(raw: any) => ParsedListing} normalize Function to convert raw scraped data into a ParsedListing shape.
 * @property {(url: string, waitForSelector?: string) => Promise<any[]>} [getListings] Optional override to fetch listings.
 * @property {(listing:ParsedListing, browser:any)=>Promise<Object>} [captureDetails] Capture complete provider detail evidence for asynchronous parsing.
 * @property {Object} [puppeteerOptions] Puppeteer specific options.
 * @property {boolean} [enabled] Whether the provider is enabled.
 */

export {};
