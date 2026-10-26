// A node:test reporter that writes a Vitest-style JSON report, so the traceability check
// reads the script tests the same way as the Vitest suites. Each test's full name is its
// describe titles and its own, joined by spaces, as in Vitest.
export default async function* jsonReporter(source) {
  // Per file and nesting level, the finished tests waiting for their enclosing suite.
  // node:test reports a suite after all of its children.
  const pending = new Map();
  const results = [];
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { name, nesting, file, details, skip, todo } = event.data;
    const levels = pending.get(file) ?? [];
    pending.set(file, levels);
    const children = levels[nesting + 1] ?? [];
    levels[nesting + 1] = [];

    let entries;
    if (details?.type === 'suite' && children.length > 0) {
      entries = children.map((child) => ({ ...child, fullName: `${name} ${child.fullName}` }));
    } else if (details?.type === 'suite') {
      // A skipped (or empty) suite reports none of its tests; keep the suite itself, so the
      // IDs in its title stay visible to the traceability check.
      entries = [
        { fullName: name, title: name, status: event.type === 'test:fail' ? 'failed' : 'skipped' },
      ];
    } else {
      const status = event.type === 'test:fail' ? 'failed' : skip || todo ? 'skipped' : 'passed';
      entries = [{ fullName: name, title: name, status }];
    }
    if (nesting === 0) results.push(...entries);
    else (levels[nesting] ??= []).push(...entries);
  }
  yield `${JSON.stringify({ testResults: [{ name: 'node:test', assertionResults: results }] }, null, 2)}\n`;
}
