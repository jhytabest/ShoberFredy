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

  {
    files: ['tools/**/*.js', 'copyright.js'],
    rules: {
      'no-console': 'off',
    },
  },

  {
    files: ['lib/services/extractor/puppeteerExtractor.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  prettier,
];
