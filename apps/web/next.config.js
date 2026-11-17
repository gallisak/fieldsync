const { existsSync, readFileSync } = require('fs');
const { resolve } = require('path');
const { parseEnv } = require('util');

// Next reads only apps/web/.env*; the repository keeps one .env at its root. Variables already set win
// (the Docker build passes NEXT_PUBLIC_API_URL as a build argument).
const rootEnv = resolve(__dirname, '../../.env');
if (existsSync(rootEnv)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(rootEnv, 'utf8')))) process.env[key] ??= value;
}

/** @type {import('next').NextConfig} */
module.exports = { reactStrictMode: false, transpilePackages: ['@fieldsync/sync-core'] };
