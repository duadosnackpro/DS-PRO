// ESLint 9 (flat config). Tujuan: menangkap BUG nyata (variabel tak terdefinisi, kunci ganda, kode tak terjangkau, penugasan ke const),
// bukan menegakkan gaya. Aturan yang berisik di basis kode lama diturunkan ke "warn" agar tidak menghalangi CI; naikkan bertahap.
import js from '@eslint/js';
import globals from 'globals';

const lenient = {
  'no-empty': 'off',               // catch (e) {} sengaja dipakai untuk "gagal diam-diam" yang aman
  'no-unused-vars': ['warn', {args: 'none', caughtErrors: 'none'}],
  'no-useless-escape': 'warn',
  'no-cond-assign': 'warn',
  'no-prototype-builtins': 'warn',
  'no-inner-declarations': 'off',
  'no-control-regex': 'warn',
  'no-fallthrough': 'warn',
  'no-case-declarations': 'warn',
  'no-misleading-character-class': 'warn',
  'no-async-promise-executor': 'warn',
  'no-sparse-arrays': 'warn',
  'no-constant-binary-expression': 'warn',
  'no-constant-condition': ['warn', {checkLoops: false}],
  'no-redeclare': 'warn',
  'no-shadow-restricted-names': 'warn',
  'no-self-assign': 'warn',
  'no-empty-character-class': 'warn',
  'no-regex-spaces': 'warn',
  'no-unsafe-finally': 'warn',
  'no-loss-of-precision': 'warn',
  'no-unused-labels': 'warn',
  'getter-return': 'warn',
};

export default [
  {ignores: ['node_modules/**', 'src/**', 'types/**', '_site/**']}, // src/app/*.js adalah potongan satu fungsi: yang dilint adalah hasil bangun web/js/app.js
  js.configs.recommended,
  {
    files: ['web/js/**/*.js'],
    languageOptions: {ecmaVersion: 2022, sourceType: 'script', globals: {...globals.browser}},
    rules: lenient,
  },
  {
    files: ['web/sw.js'],
    languageOptions: {ecmaVersion: 2022, sourceType: 'script', globals: {...globals.serviceworker}},
    rules: lenient,
  },
  {
    files: ['tests/**/*.js', 'tools/**/*.js'],
    languageOptions: {ecmaVersion: 2022, sourceType: 'commonjs', globals: {...globals.node, ...globals.browser}},
    rules: lenient,
  },
  {files: ['eslint.config.mjs'], languageOptions: {sourceType: 'module'}},
];
