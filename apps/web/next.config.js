const { existsSync, readFileSync } = require('fs');
const { resolve } = require('path');
const { parseEnv } = require('util');

// Next reads only apps/web/.env*; the repository's .env is at its root. Variables already set win.
const rootEnv = resolve(__dirname, '../../.env');
if (existsSync(rootEnv)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(rootEnv, 'utf8')))) process.env[key] ??= value;
}

/** @type {import('next').NextConfig} */
module.exports = { reactStrictMode: true, transpilePackages: ['@fieldsync/sync-core'] };
