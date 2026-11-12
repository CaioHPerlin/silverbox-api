async function current({ github, context, core }, sha) {
  const { data: branch } = await github.rest.repos.getBranch({ ...context.repo, branch: 'main' });
  const matches = branch.commit.sha === sha;
  core.setOutput('current', String(matches));
  if (!matches) core.notice('Revision superseded by main; release skipped.');
  return matches;
}
async function authorize({ github, context, core }) {
  core.setOutput('ready', 'false');
  let sha;
  if (context.eventName === 'workflow_run') {
    const run = context.payload.workflow_run;
    const { data: workflow } = await github.rest.actions.getWorkflow({ ...context.repo, workflow_id: 'ci.yml' });
    if (run.workflow_id !== workflow.id || run.conclusion !== 'success' || run.event !== 'push' || run.head_branch !== 'main' || run.head_repository?.full_name !== `${context.repo.owner}/${context.repo.repo}`) {
      throw new Error('Only successful main push CI runs from this repository may publish.');
    }
    sha = run.head_sha;
  } else if (context.eventName === 'workflow_dispatch' && context.ref === 'refs/heads/main') {
    sha = context.sha;
    const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
      ...context.repo, workflow_id: 'ci.yml', branch: 'main', head_sha: sha, status: 'success', per_page: 100,
    });
    if (!runs.some(run => run.head_sha === sha && run.head_branch === 'main' && run.conclusion === 'success' && ['push', 'workflow_dispatch'].includes(run.event) && run.head_repository?.full_name === `${context.repo.owner}/${context.repo.repo}`)) {
      throw new Error('This main revision has no successful CI run.');
    }
  } else {
    throw new Error('Manual releases must select main.');
  }
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Invalid release SHA.');
  if (!await current({ github, context, core }, sha)) return;
  core.setOutput('sha', sha);
  core.setOutput('ready', 'true');
}
module.exports = { authorize, current };
