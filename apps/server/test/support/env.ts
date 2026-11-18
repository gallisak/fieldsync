import { readEnvFile } from '../../src/config/env';

for (const [key, value] of Object.entries(readEnvFile())) process.env[key] ??= value;
