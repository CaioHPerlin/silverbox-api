import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const component = process.env.DEPLOY_COMPONENT;
const image = process.env.DEPLOY_IMAGE;
const token = process.env.DEPLOY_TOKEN;
const username = process.env.DEPLOY_USER;

test('ARM64 production release becomes healthy and failed replacement restores previous release',
  { timeout: 480_000 }, () => {
  assert.ok(component && image && token && username, 'All DEPLOY_* variables are required; this check must never be skipped');
  assert.ok(component === 'api' || component === 'web');
  const root = mkdtempSync(join(tmpdir(), 'silverbox-release-'));
  const project = `silverbox-release-${component}-${process.pid}`;
  let createdNetwork = false;
  const run = (cmd: string, args: string[], input?: string) => execFileSync(cmd, args, {
    encoding: 'utf8', input, env: { ...process.env, IMAGE: image }, timeout: 240_000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const prepare = (name: string, unhealthy = false) => {
    const dir = join(root, 'releases', name);
    mkdirSync(dir, { recursive: true });
    copyFileSync('deploy/release.sh', join(dir, 'release.sh'));
    let compose = readFileSync('deploy/compose.yml', 'utf8').replace(`name: silverbox-${component}`, `name: ${project}`).replace("traefik.enable: 'true'", "traefik.enable: 'false'");
    if (unhealthy) {
      if (component === 'api') {
        compose = compose.replace(/test: \['CMD', 'node', '-e', .*?\]/, "test: ['CMD', 'false']")
          .replace('start_period: 30s', 'start_period: 0s').replace('retries: 24', 'retries: 1');
      } else {
        compose = compose.replace('    restart: unless-stopped', "    restart: unless-stopped\n    healthcheck:\n      test: ['CMD', 'false']\n      interval: 1s\n      retries: 1\n      start_period: 0s");
      }
    }
    writeFileSync(join(dir, 'compose.yml'), compose);
    return dir;
  };
  const first = prepare('good');
  writeFileSync(join(root, '.env'), [
    'API_HOST=api.silverbox.test', 'WEB_HOST=web.silverbox.test',
    'POSTGRES_PASSWORD=ciOnlySafeHexPassword', 'BETTER_AUTH_SECRET=ci-secret-0123456789abcdef0123456789abcdef',
  ].join('\n') + '\n', { mode: 0o600 });
  const compose = (...args: string[]) => run('docker', ['compose', '--project-directory', first, '-f', join(first, 'compose.yml'), ...args]);
  const release = (dir: string) => run('bash', [join(dir, 'release.sh'), image!, username!], token);
  try {
    if (spawnSync('docker', ['network', 'inspect', 'traefik'], { stdio: 'ignore' }).status !== 0) {
      run('docker', ['network', 'create', 'traefik']);
      createdNetwork = true;
    }
    release(first);
    assert.equal(readlinkSync(join(root, 'current')), first);
    if (component === 'api') {
      const code = `
        const assert = require('node:assert/strict');
        (async () => {
          const base='http://127.0.0.1:8000';
          assert.equal((await fetch(base+'/health/ready')).status,200);
          const signup=await fetch(base+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://web.silverbox.test'},body:JSON.stringify({name:'ARM Release',email:'release-'+Date.now()+'@example.com',password:'correct-horse-battery-staple'})});
          assert.equal(signup.status,200);
          const cookie=signup.headers.getSetCookie().find(v=>v.includes('session_token')).split(';')[0];
          const upload=await fetch(base+'/files',{method:'POST',headers:{Origin:'https://web.silverbox.test',Cookie:cookie,'Content-Type':'application/octet-stream','X-File-Name':'arm.txt','X-File-Size':'5','X-File-Mime':'text/plain'},body:'hello'});
          assert.equal(upload.status,201);
          const file=(await upload.json()).file;
          const downloaded=await fetch(base+'/files/'+file.id+'/download',{headers:{Cookie:cookie}});
          assert.equal(downloaded.status,200);
          assert.equal(await downloaded.text(),'hello');
          assert.match(signup.headers.get('set-cookie'),/Secure/i);
          assert.equal(process.getuid(),1000);
          console.log('production-ready, registration, secure cookie, uid1000');
        })().catch(e=>{console.error(e);process.exit(1)});
      `;
      assert.match(compose('exec', '-T', 'api', 'node', '-e', code), /production-ready/);
    } else {
      assert.match(compose('exec', '-T', 'web', 'wget', '-qO-', 'http://127.0.0.1:8080/runtime-config.js'), /https:\/\/api.silverbox.test/);
      assert.match(compose('exec', '-T', 'web', 'wget', '-qO-', 'http://127.0.0.1:8080/arquivos'), /<title>Silverbox/);
    }
    const broken = prepare('broken', true);
    assert.throws(() => release(broken));
    assert.equal(readlinkSync(join(root, 'current')), first);
    compose('up', '-d', '--wait', '--wait-timeout', '60');
  } finally {
    try { compose('down', '-v', '--remove-orphans'); } finally {
      if (createdNetwork) run('docker', ['network', 'rm', 'traefik']);
      rmSync(root, { recursive: true, force: true });
    }
  }
});
