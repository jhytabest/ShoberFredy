/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Fixed-destination TCP ingress for Docker Desktop.
 *
 * Docker Desktop does not publish host ports from an internal-only network.
 * This process has no application data or secrets; it bridges the published
 * port to the API container while the API container remains on its isolated
 * network with no outbound route.
 */

import net from 'node:net';

const LISTEN_PORT = 9998;
const TARGET_HOST = 'shoberfredy';
const TARGET_PORT = 9998;

const server = net.createServer((incoming) => {
  const upstream = net.createConnection({ host: TARGET_HOST, port: TARGET_PORT });
  incoming.on('error', () => upstream.destroy());
  upstream.on('error', () => incoming.destroy());
  incoming.pipe(upstream);
  upstream.pipe(incoming);
});

server.listen(LISTEN_PORT, '0.0.0.0');
