const { execFileSync } = require('node:child_process');

const dependencyPath = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.nvmrc|\.node-version|\.tool-versions)$/;
function requiresNpm(paths) {
  return paths.some(path => dependencyPath.test(path) || path.startsWith('.github/'));
}
function detect(context, git = args => execFileSync('git', args, { encoding: 'utf8' })) {
  if (context.eventName === 'workflow_dispatch') return true;
  const payload = context.payload;
  const base = context.eventName === 'pull_request' ? payload.pull_request?.base.sha : payload.before;
  const head = context.eventName === 'pull_request' ? payload.pull_request?.head.sha : payload.after;
  if (![base, head].every(sha => /^[a-f0-9]{40}$/.test(sha ?? '') && !/^0+$/.test(sha))) return true;
  try {
    const start = context.eventName === 'pull_request' ? git(['merge-base', base, head]).trim() : base;
    return requiresNpm(git(['diff', '--name-only', '--no-renames', start, head]).trim().split('\n'));
  } catch { return true; }
}
module.exports = { requiresNpm, detect };
