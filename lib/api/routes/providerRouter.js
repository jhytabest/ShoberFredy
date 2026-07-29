/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getProviders } from '../../utils.js';

/**
 * This used to read `./lib/provider` itself, relative to the working directory,
 * which meant starting the process from anywhere but the repository root killed
 * it at import time with ENOENT before the workers were ever reached. Reusing
 * the loader in utils.js fixes that — it resolves against the module's own
 * location — and leaves one implementation of "which providers exist".
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function providerPlugin(fastify) {
  const providers = await getProviders();

  fastify.get('/', async () => {
    return providers.map((provider) => provider.metaInformation);
  });
}
