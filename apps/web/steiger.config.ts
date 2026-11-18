import fsd from '@feature-sliced/steiger-plugin';
import { defineConfig } from 'steiger';

export default defineConfig([
  ...fsd.configs.recommended,
  {
    files: ['./src/shared/ui/**'],
    rules: { 'fsd/public-api': 'off' },
  },
  {
    // Each widget is used by one page and each feature by one widget, on purpose: a page stays a short list of
    // named blocks, and every user action is its own slice.
    files: ['./src/widgets/**', './src/features/**'],
    rules: { 'fsd/insignificant-slice': 'off' },
  },
  {
    // `src/app/providers` is the conventional home of the app's context providers.
    files: ['./src/app/**'],
    rules: { 'fsd/segments-by-purpose': 'off' },
  },
]);
