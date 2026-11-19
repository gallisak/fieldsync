const { randomUUID } = require('crypto');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { resolve } = require('path');
const { parseEnv } = require('util');

const rootEnv = resolve(__dirname, '../../.env');
if (existsSync(rootEnv)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(rootEnv, 'utf8')))) process.env[key] ??= value;
}

// Runs only for `next build`: the service worker's cache is named after the build, so a new build replaces it.
function writeServiceWorker(buildId) {
  const template = readFileSync(resolve(__dirname, 'sw.template.js'), 'utf8');
  mkdirSync(resolve(__dirname, 'public'), { recursive: true });
  writeFileSync(resolve(__dirname, 'public/sw.js'), template.replace('__BUILD_ID__', buildId));
}

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  transpilePackages: ['@fieldsync/sync-core'],
  generateBuildId: () => {
    const buildId = randomUUID();
    writeServiceWorker(buildId);
    return buildId;
  },
};
