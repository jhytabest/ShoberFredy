/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

// Before incremental migrations, migration 100 was deliberately mutable. These
// SHA-256 values are its historical file contents on main, with their source
// commits. Never replay historical code: advance through the frozen baseline's
// existing upgrade logic, and only while it is the sole ledger entry.
const BASELINE_NAME = '100.current-schema.js';
const FROZEN_BASELINE_CHECKSUM = 'ce5a159bf4c76a192302a38e1be4f1f5c6413c3f4f5edd68fe28504a2ba502df';
const LEGACY_BASELINE_CHECKSUMS = new Set([
  '151b2d4d17d7027bde0f74d7a33591b7d4477327998335f9808e73d6f9d56eb3', // 01b85ece3317
  '37201e6a1ca480a0e2f6f2d3d97e0ab8ea939e7fe8ec7d0b8cef358f5f52c0cf', // 71e3adfaaba1
  '2d5b3087c62a1c7df8e4f1ff22290b31a63ddd6d6ea1522fbef4a7b778cd2230', // a2f44857ca84
  '6388b74f9dba49817f63d8be621c32cea76716d3b761363156b59494d1f51333', // db711e5e2484
  '71177e81f959d1f1a15342a6dc1bb60226bdee61afaa83e0696da57a0f2add10', // 7b6d0a3e60b5
  'da426d732c6592ac2de3a22d9412f8bdd90eb4231be80580d674a9c94bc53611', // e9515615d06b
  '2fb88d7e152d434b61e15b7a1b5e1b2364d82385c39338a1dd7fff9023456e40', // a857dc290460
  '08b40df1ab290b6fa4cf551118921e05917114742c11ddd8ef38b6866509d18d', // ea3a6cce3cad
  'fd496ef6451487ae3681f0e83d239d3d891d9bb49a33de9ab9b108ccda5ac78a', // 7fbf78a5bca2
  '544205f57b22ca22909c74138882158ec726755942f7425719454dd4535a80ae', // 93fb254c2b2b
  'ae6ba17bc13af50806682d84b42a67049dfaa519a72518ac042078d07e79866b', // af7bc34c0926
  '05d63f42735a04a00cbdd46ede50be6772cba13e577735861c42b723d8a2bb56', // 415594023852
  'bea019c425383c253e6fc87b376124eafa28fc29eb17dde37f1935842e4585c2', // 7f2e519454dd
  '64df4f8a57cb801ecff80169acdd225b5724366e03ac484cf42a163c23467ae6', // 7d249041a43e
  '427291100b44260683ded24cd64a743a951586c78e2faf708ad3b781ec323ee8', // c3185708e4a1
  '7be048b4dbcf14d9311b29ed07bbbc1525c1b0e0e6d244cb7c09cb6758e7d33a', // 185f3dc09c16
  '2d8694cd645849b3ec856003e9bd45d76e9fe78114b4ee6c40d7988a99325c55', // 068e6bd23eb8
  'dca48984cb214a7d034066ceba8a0a8d0d5e8488ea08302b30de6016d720362d', // 6422c3b51bd0
  '92230b51e5ed32b2221ed3a6d160d024d1fec3a27065740af4cdbea58fca13b7', // 165620bf32f8
  'b9a47fdbf7f346f5b2482c2c247d74203489b33acf575f1824b76dfbb4577723', // 0d030ad8ce3a
]);

const SOURCE_IDENTITY_MIGRATION = '101.archive-and-event-history.js';
const BROKEN_SOURCE_IDENTITY_CHECKSUM = '9218b14a26c36f5d8d35999fea2f4bca14d79311b4327d59f8f93e2799221651';
const CORRECTED_SOURCE_IDENTITY_CHECKSUM = '9800a47d451762194fec21221f783049e5456db53335bcb6bba809535be63e37';

export function isLegacyBaselineUpgrade(name, checksum, executed) {
  return (
    name === BASELINE_NAME &&
    checksum === FROZEN_BASELINE_CHECKSUM &&
    executed.size === 1 &&
    LEGACY_BASELINE_CHECKSUMS.has(executed.get(BASELINE_NAME))
  );
}

// The original migration used a streaming SELECT and wrote through the same
// connection before that SELECT finished. It succeeded only when
// listing_sources was empty. Such databases already completed every other
// operation in the migration, so advance their ledger without replaying it.
export function isCorrectedSourceIdentityUpgrade(name, checksum, executed) {
  return (
    name === SOURCE_IDENTITY_MIGRATION &&
    checksum === CORRECTED_SOURCE_IDENTITY_CHECKSUM &&
    executed.get(SOURCE_IDENTITY_MIGRATION) === BROKEN_SOURCE_IDENTITY_CHECKSUM
  );
}
