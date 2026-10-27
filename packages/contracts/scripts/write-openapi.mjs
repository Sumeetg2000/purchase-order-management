// Writes the committed OpenAPI document from the built generator (`npm run
// contract:generate` builds first). CI reruns this and fails if the file changes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { serializeOpenApiDocument } from '../dist/openapi.js';

const output = new URL('../openapi/openapi.json', import.meta.url);
mkdirSync(new URL('.', output), { recursive: true });
writeFileSync(output, serializeOpenApiDocument());
console.log(`contract:generate: wrote ${output.pathname}`);
