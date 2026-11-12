const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requiresNpm, detect } = require('./npm-changes.cjs');
const base = 'a'.repeat(40), head = 'b'.repeat(40), ancestor = 'c'.repeat(40);
test('dependency, Node and CI configuration require npm; application changes do not', () => {
  for (const path of ['package.json', 'app/package-lock.json', 'pnpm-lock.yaml', 'app/pnpm-workspace.yaml', '.npmrc', '.nvmrc', '.node-version', '.tool-versions', '.github/workflows/ci.yml']) assert.equal(requiresNpm([path]), true, path);
  assert.equal(requiresNpm(['src/server.ts', 'README.md']), false);
});
test('manual and uncertain comparisons fail open to npm validation', () => {
  assert.equal(detect({ eventName: 'workflow_dispatch' }), true);
  assert.equal(detect({ eventName: 'push', payload: { before: '0'.repeat(40), after: head } }), true);
  assert.equal(detect({ eventName: 'push', payload: { before: base, after: head } }, () => { throw Error('missing commit'); }), true);
});
test('push compares the previous SHA and PR compares the merge base', () => {
  const calls = [];
  const git = args => { calls.push(args); return args[0] === 'merge-base' ? ancestor : 'src/server.ts\n'; };
  assert.equal(detect({ eventName: 'push', payload: { before: base, after: head } }, git), false);
  assert.deepEqual(calls.pop(), ['diff', '--name-only', '--no-renames', base, head]);
  assert.equal(detect({ eventName: 'pull_request', payload: { pull_request: { base: { sha: base }, head: { sha: head } } } }, git), false);
  assert.deepEqual(calls, [['merge-base', base, head], ['diff', '--name-only', '--no-renames', ancestor, head]]);
});
