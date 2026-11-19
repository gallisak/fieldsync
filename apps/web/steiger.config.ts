import fsd from '@feature-sliced/steiger-plugin';
import { defineConfig } from 'steiger';

export default defineConfig([
  ...fsd.configs.recommended,
  {
    // One slice per noun, verb and screen block, however many slices use it.
    rules: { 'fsd/insignificant-slice': 'off' },
  },
  {
    files: ['./src/shared/ui/**'],
    rules: { 'fsd/public-api': 'off' },
  },
  {
    files: ['./src/app/**'],
    rules: { 'fsd/segments-by-purpose': 'off' },
  },
]);
