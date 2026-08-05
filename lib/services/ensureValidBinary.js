/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { ensureBinary } from 'cloakbrowser';
import fs from 'fs';
import path from 'path';
import os from 'os';

const LINUX_WIN_REQUIRED_FILES = ['icudtl.dat', 'resources.pak'];

function getVersionedDir(binaryPath) {
  if (process.platform === 'darwin') {
    return path.resolve(path.dirname(binaryPath), '../../..');
  }
  return path.dirname(binaryPath);
}

function isBinaryComplete(binaryPath) {
  if (process.platform === 'darwin') {
    const contentsDir = path.resolve(path.dirname(binaryPath), '..');
    return fs.existsSync(path.join(contentsDir, 'Info.plist')) && fs.existsSync(path.join(contentsDir, 'Frameworks'));
  }
  const dir = path.dirname(binaryPath);
  return LINUX_WIN_REQUIRED_FILES.every((f) => fs.existsSync(path.join(dir, f)));
}

function missingDescription(binaryPath) {
  if (process.platform === 'darwin') {
    const contentsDir = path.resolve(path.dirname(binaryPath), '..');
    return ['Info.plist', 'Frameworks'].filter((f) => !fs.existsSync(path.join(contentsDir, f))).join(', ');
  }
  const dir = path.dirname(binaryPath);
  return LINUX_WIN_REQUIRED_FILES.filter((f) => !fs.existsSync(path.join(dir, f))).join(', ');
}

function removeCorruptInstallation(binaryPath) {
  const versionedDir = getVersionedDir(binaryPath);
  const cacheDir = process.env.CLOAKBROWSER_CACHE_DIR || path.join(os.homedir(), '.cloakbrowser');

  fs.rmSync(versionedDir, { recursive: true, force: true });

  try {
    for (const entry of fs.readdirSync(cacheDir)) {
      if (entry.startsWith('latest_version')) {
        fs.rmSync(path.join(cacheDir, entry), { force: true });
      }
    }
  } catch {
    // Cache dir may not exist if versionedDir was the only entry — ignore.
  }
}

export async function ensureValidBinary() {
  const binaryPath = await ensureBinary();

  if (isBinaryComplete(binaryPath)) {
    process.env.CLOAKBROWSER_BINARY_PATH = binaryPath;
    return binaryPath;
  }

  console.warn(
    `[fredy] CloakBrowser installation at ${getVersionedDir(binaryPath)} is missing: ${missingDescription(binaryPath)}. Removing and retrying.`,
  );

  removeCorruptInstallation(binaryPath);

  const fallbackPath = await ensureBinary();
  if (!isBinaryComplete(fallbackPath)) {
    throw new Error(
      `CloakBrowser binary at ${getVersionedDir(fallbackPath)} is still missing required files after re-download: ${missingDescription(fallbackPath)}`,
    );
  }

  process.env.CLOAKBROWSER_BINARY_PATH = fallbackPath;
  return fallbackPath;
}
