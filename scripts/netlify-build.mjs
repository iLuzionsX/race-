import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const jobsDir = path.join(root, '.ox/jobs');
const distDir = path.join(root, 'dist');

function childEnv(mode, tokenEnv = 'OX_GITHUB_WRITE_TOKEN') {
  const env = { ...process.env };
  if (mode === 'ox') delete env[tokenEnv];
  if (mode === 'finalize') delete env.NOUS_API_KEY;
  if (mode === 'plain') {
    delete env.NOUS_API_KEY;
    delete env[tokenEnv];
  }
  return env;
}

function run(command, args, timeoutMs, mode, tokenEnv) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    timeout: timeoutMs,
    env: childEnv(mode, tokenEnv),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
}

function writeDiagnostic(message) {
  fs.mkdirSync(distDir, { recursive: true });
  const safe = String(message).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  fs.writeFileSync(path.join(distDir, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ox dispatcher diagnostic</title><style>body{font:16px system-ui;background:#111;color:#eee;padding:32px}main{max-width:900px;margin:auto}pre{white-space:pre-wrap;background:#1d1d1d;padding:16px;border-radius:8px}</style><main><h1>Ox dispatcher diagnostic</h1><pre>${safe}</pre></main>`);
  console.error(`OX DISPATCHER DIAGNOSTIC: ${message}`);
}

function loadJobs() {
  return fs.readdirSync(jobsDir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => ({ name, job: JSON.parse(fs.readFileSync(path.join(jobsDir, name), 'utf8')) }));
}

try {
  const active = loadJobs().filter(entry => entry.job.enabled === true);
  if (active.length > 1) throw new Error(`Refusing to run ${active.length} enabled Ox jobs. Exactly zero or one is allowed.`);

  if (active.length === 1) {
    const tokenEnv = active[0].job.persistence?.token_env || 'OX_GITHUB_WRITE_TOKEN';
    console.log(`OX DISPATCHER: running ${active[0].job.id || active[0].name}`);
    run(process.execPath, ['scripts/ox-build.mjs'], 1_800_000, 'ox', tokenEnv);
    run(process.execPath, ['scripts/ox-finalize.mjs'], 120_000, 'finalize', tokenEnv);
    run(process.execPath, ['scripts/diagnostic-marker.mjs'], 30_000, 'plain', tokenEnv);
    run(process.execPath, ['scripts/success-marker.mjs'], 30_000, 'plain', tokenEnv);
  } else {
    console.log('OX DISPATCHER: no enabled jobs; building persisted source normally.');
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], 180_000, 'plain');
    run(path.join(root, 'node_modules/.bin/vite'), ['build'], 180_000, 'plain');
  }
} catch (error) {
  writeDiagnostic(error?.message || error);
}
