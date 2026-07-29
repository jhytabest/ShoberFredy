/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: ['**/node_modules/**', 'db/**', 'conf/**'],
  },

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        fetch: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // Standalone CLIs and the maintenance toolkit report via stdout by design.
  {
    files: ['tools/**/*.js', 'copyright.js'],
    rules: {
      'no-console': 'off',
    },
  },

  // page.evaluate() bodies are serialised and run inside the headless browser,
  // so they legitimately reference DOM globals that do not exist in Node.
  {
    files: ['lib/services/extractor/puppeteerExtractor.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  prettier,
];
