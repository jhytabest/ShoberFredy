/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { parentPort, workerData } from 'node:worker_threads';

import { parse } from './parser.js';

try {
  parentPort.postMessage({
    result: parse(workerData.crawlContainer, workerData.crawlFields, workerData.text, workerData.url),
  });
} catch (error) {
  parentPort.postMessage({ error: String(error?.stack || error) });
}
