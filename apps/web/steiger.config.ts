import fsd from '@feature-sliced/steiger-plugin';
import { defineConfig } from 'steiger';

export default defineConfig([
  ...fsd.configs.recommended,
  {
    // One slice per noun, verb and screen block, however many slices use it: a page stays a short list of
    // named widgets, every user action is its own feature, and `part` is read by one widget only.
    rules: { 'fsd/insignificant-slice': 'off' },
  },
  {
    files: ['./src/shared/ui/**'],
    rules: { 'fsd/public-api': 'off' },
  },
  {
    // `src/app/providers` is the conventional home of the app's context providers.
    files: ['./src/app/**'],
    rules: { 'fsd/segments-by-purpose': 'off' },
  },
]);
