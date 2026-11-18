import fsd from '@feature-sliced/steiger-plugin';
import { defineConfig } from 'steiger';

export default defineConfig([
  ...fsd.configs.recommended,
  {
    files: ['./src/shared/ui/**'],
    rules: { 'fsd/public-api': 'off' },
  },
  {
    // Each widget is used by one page on purpose: pages stay a short list of named blocks.
    files: ['./src/widgets/**'],
    rules: { 'fsd/insignificant-slice': 'off' },
  },
]);
