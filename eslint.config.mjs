// Lint configuration for the whole repository.
//
// `script.js` is a classic browser script (globals from the page, no modules),
// while the tests and this file are Node ES modules — the two need different
// globals, which is why the config is split by `files`.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'coverage/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    rules: js.configs.recommended.rules,
  },
  {
    files: ['script.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },
  {
    files: ['tests/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
];
