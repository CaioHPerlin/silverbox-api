const { test } = require('node:test');
const assert = require('node:assert/strict');
const { authorize, current } = require('./release.cjs');
const sha = 'a'.repeat(40);
function fixture(eventName = 'workflow_run') {
  const outputs = {};
  const run = { workflow_id: 7, conclusion: 'success', event: 'push', head_branch: 'main', head_sha: sha, head_repository: { full_name: 'owner/repo' } };
  const api = {
    context: { eventName, repo: { owner: 'owner', repo: 'repo' }, ref: 'refs/heads/main', sha, payload: { workflow_run: run } },
    github: { rest: { repos: { getBranch: async () => ({ data: { commit: { sha } } }) }, actions: { getWorkflow: async () => ({ data: { id: 7 } }), listWorkflowRuns() {} } }, paginate: async () => [run] },
    core: { setOutput: (key, value) => { outputs[key] = value; }, notice() {} },
  };
  return { api, outputs, run };
}
test('successful main push publishes exactly its validated SHA', async () => {
  const { api, outputs } = fixture(); await authorize(api);
  assert.equal(outputs.sha, sha); assert.equal(outputs.ready, 'true');
});
test('failed, cancelled, PR, foreign and unrelated workflow runs cannot publish', async () => {
  for (const patch of [{ conclusion: 'failure' }, { conclusion: 'cancelled' }, { event: 'pull_request' }, { head_branch: 'feature' }, { head_repository: { full_name: 'fork/repo' } }, { workflow_id: 9 }]) {
    const { api, outputs, run } = fixture(); Object.assign(run, patch);
    await assert.rejects(authorize(api)); assert.equal(outputs.ready, 'false');
  }
});
test('superseded revisions are skipped both at authorization and before applying', async () => {
  const { api, outputs } = fixture();
  api.github.rest.repos.getBranch = async () => ({ data: { commit: { sha: 'b'.repeat(40) } } });
  await authorize(api); assert.equal(outputs.ready, 'false');
  assert.equal(await current(api, sha), false);
});
test('manual releases require main and successful CI for the exact SHA', async () => {
  const { api, outputs } = fixture('workflow_dispatch'); await authorize(api); assert.equal(outputs.ready, 'true');
  api.github.paginate = async () => []; await assert.rejects(authorize(api), /no successful CI/);
  api.context.ref = 'refs/heads/feature'; await assert.rejects(authorize(api), /select main/);
});
