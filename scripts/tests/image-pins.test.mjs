// Container images that CI runs are pinned by digest as well as tag, like the actions
// (ADR-0020): a re-pushed tag can't change what runs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FILES = [
  ...readdirSync(join(ROOT, '.github/workflows')).map((f) => join('.github/workflows', f)),
  ...readdirSync(join(ROOT, 'scripts'))
    .filter((f) => f.endsWith('.sh'))
    .map((f) => join('scripts', f)),
];

// registry/name:tag, optionally followed by @sha256:<64 hex>.
const IMAGE = /\b[a-z0-9.-]+(?:\/[a-z0-9._-]+)+:v?\d[\w.-]*(@sha256:[0-9a-f]{64})?/g;

describe('[NFR-OPS-02] CI container images', () => {
  it('[NFR-OPS-02] every image in the workflows and CI scripts is pinned by digest', () => {
    const images = FILES.flatMap((file) =>
      [...readFileSync(join(ROOT, file), 'utf8').matchAll(IMAGE)].map((m) => ({
        file,
        image: m[0],
        pinned: m[1] !== undefined,
      })),
    );
    assert.ok(images.length >= 3, `found only ${images.map((i) => i.image).join(', ')}`);
    assert.deepEqual(
      images.filter((i) => !i.pinned).map((i) => `${i.file}: ${i.image}`),
      [],
    );
  });
});
