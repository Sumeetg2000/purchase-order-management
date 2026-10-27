#!/usr/bin/env node
// The bundle budget (ADR-0012, research R21), from Vite's build manifest, gzip-measured:
//   - the initial JS (the entry chunk plus everything it imports statically) ≤ 200 KB
//   - each lazy route chunk, plus what it imports that the entry doesn't already load,
//     ≤ 150 KB
// Run after `npm run build -w @po/frontend`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const BUNDLE_BUDGET_KB = { initial: 200, lazyChunk: 150 };

/** Measures a Vite build directory that has .vite/manifest.json. */
export function measureBundle(distDir) {
  const manifest = JSON.parse(readFileSync(join(distDir, '.vite/manifest.json'), 'utf8'));
  const keys = Object.keys(manifest);
  const entry = keys.find((key) => manifest[key].isEntry);
  if (!entry) throw new Error('check-bundle-budget: the manifest has no entry chunk');

  // A chunk and its static imports, depth first, each once.
  const closure = (key, seen = new Set()) => {
    if (seen.has(key) || !manifest[key]) return seen;
    seen.add(key);
    for (const imported of manifest[key].imports ?? []) closure(imported, seen);
    return seen;
  };
  const kb = (files) =>
    files.reduce((sum, file) => sum + gzipSync(readFileSync(join(distDir, file))).length, 0) / 1024;

  const initial = closure(entry);
  const initialFiles = [...initial].map((key) => manifest[key].file);
  const lazyChunks = keys
    .filter((key) => manifest[key].isDynamicEntry)
    .map((key) => {
      const files = [...closure(key)]
        .filter((chunk) => !initial.has(chunk))
        .map((chunk) => manifest[chunk].file);
      return { name: key, files, kb: kb(files) };
    });
  return { initialFiles, initialKb: kb(initialFiles), lazyChunks };
}

export function checkBundleBudget(distDir, budget = BUNDLE_BUDGET_KB) {
  const sizes = measureBundle(distDir);
  const errors = [];
  if (sizes.initialKb > budget.initial) {
    errors.push(
      `initial JS is ${sizes.initialKb.toFixed(1)} KB gzip, over the ${String(budget.initial)} KB budget (${sizes.initialFiles.join(', ')})`,
    );
  }
  for (const chunk of sizes.lazyChunks) {
    if (chunk.kb > budget.lazyChunk) {
      errors.push(
        `lazy chunk ${chunk.name} is ${chunk.kb.toFixed(1)} KB gzip, over the ${String(budget.lazyChunk)} KB budget (${chunk.files.join(', ')})`,
      );
    }
  }
  return { ...sizes, errors };
}

function main() {
  const dist = fileURLToPath(new URL('../frontend/dist/', import.meta.url));
  const result = checkBundleBudget(dist);
  console.log(
    `check-bundle-budget: initial ${result.initialKb.toFixed(1)} KB / ${String(BUNDLE_BUDGET_KB.initial)} KB`,
  );
  for (const chunk of result.lazyChunks) {
    console.log(
      `  ${chunk.name}: ${chunk.kb.toFixed(1)} KB / ${String(BUNDLE_BUDGET_KB.lazyChunk)} KB`,
    );
  }
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log('check-bundle-budget: ok');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
