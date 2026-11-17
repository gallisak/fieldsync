import { readEnvFile } from '../../src/config/env';

// Local runs take DATABASE_URL (and the rest) from the repository's .env; anything already set wins (CI).
for (const [key, value] of Object.entries(readEnvFile())) process.env[key] ??= value;
