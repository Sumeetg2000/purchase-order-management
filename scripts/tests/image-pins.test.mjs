// Container images that CI and the pre-commit hook run are pinned by digest as well as
// tag, like the actions (ADR-0020): a re-pushed tag can't change what runs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FILES = [
  'lefthook.yml',
  ...readdirSync(join(ROOT, '.github/workflows')).map((f) => join('.github/workflows', f)),
  ...readdirSync(join(ROOT, 'scripts'))
    .filter((f) => f.endsWith('.sh'))
    .map((f) => join('scripts', f)),
];

// registry/name:tag, optionally followed by @sha256:<64 hex>.
const IMAGE = /\b[a-z0-9.-]+(?:\/[a-z0-9._-]+)+:v?\d[\w.-]*(@sha256:[0-9a-f]{64})?/g;

const imagesIn = () =>
  FILES.flatMap((file) =>
    [...readFileSync(join(ROOT, file), 'utf8').matchAll(IMAGE)].map((m) => ({
      file,
      image: m[0],
      pinned: m[1] !== undefined,
    })),
  );

describe('[NFR-OPS-02] CI container images', () => {
  it('[NFR-OPS-02] the pre-commit hook runs the same gitleaks image as CI', () => {
    const gitleaks = imagesIn().filter((i) => i.image.includes('gitleaks'));
    assert.ok(
      gitleaks.some((i) => i.file === 'lefthook.yml'),
      'lefthook.yml runs gitleaks',
    );
    assert.ok(
      gitleaks.some((i) => i.file.startsWith('.github/')),
      'CI runs gitleaks',
    );
    assert.deepEqual(
      [...new Set(gitleaks.map((i) => i.image))].length,
      1,
      JSON.stringify(gitleaks),
    );
  });

  it('[NFR-OPS-02] every image in the workflows and CI scripts is pinned by digest', () => {
    const images = imagesIn();
    assert.ok(images.length >= 3, `found only ${images.map((i) => i.image).join(', ')}`);
    assert.deepEqual(
      images.filter((i) => !i.pinned).map((i) => `${i.file}: ${i.image}`),
      [],
    );
  });
});
