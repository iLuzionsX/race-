import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const distDir = path.join(root, 'dist');
const oxDir = path.join(distDir, '__ox');
const jobsDir = path.join(root, '.ox/jobs');
const allFiles = ['package.json', 'index.html', 'src/main.js', 'src/physics.js', 'src/mobile-controls.js'];
const THREE_VERSION = '0.185.1';
const VITE_VERSION = '8.2.2';

function clean(value, max = 1000) {
  let text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  for (const name of ['OX_GITHUB_WRITE_TOKEN', 'NOUS_API_KEY']) {
    const secret = process.env[name];
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text.slice(0, max);
}

function loadActiveJob() {
  const entries = fs.readdirSync(jobsDir).filter(name => name.endsWith('.json')).sort();
  const parsed = entries.map(name => {
    const fullPath = path.join(jobsDir, name);
    return { fullPath, job: JSON.parse(fs.readFileSync(fullPath, 'utf8')) };
  });
  const active = parsed.filter(entry => entry.job.enabled === true);
  if (active.length !== 1) throw new Error(`Expected exactly one enabled Ox job, found ${active.length}.`);
  return active[0];
}

function verifyGeneratedSource() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg?.dependencies?.three !== THREE_VERSION) throw new Error(`three must be pinned to ${THREE_VERSION}.`);
  if (pkg?.devDependencies?.vite !== VITE_VERSION) throw new Error(`vite must be pinned to ${VITE_VERSION}.`);
  if (pkg?.scripts?.build !== 'vite build') throw new Error('build script must be exactly "vite build".');
  for (const file of allFiles) {
    const fullPath = path.join(root, file);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) throw new Error(`Missing generated file: ${file}`);
    if (!fs.readFileSync(fullPath, 'utf8').trim()) throw new Error(`Generated file is empty: ${file}`);
  }
  const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  if (!main.includes('./physics.js') || !main.includes('./mobile-controls.js')) throw new Error('src/main.js must consume both specialist modules.');
}

function snapshot() {
  return Object.fromEntries(allFiles.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
}

function aggregateHash(files) {
  const hash = crypto.createHash('sha256');
  for (const file of allFiles) {
    const content = files[file];
    hash.update(file).update('\0').update(String(Buffer.byteLength(content))).update('\0').update(content).update('\0');
  }
  return hash.digest('hex');
}

function repositoryFromRemote() {
  const env = { ...process.env };
  delete env.OX_GITHUB_WRITE_TOKEN;
  delete env.NOUS_API_KEY;
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', shell: false, env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git remote get-url origin failed: ${clean(result.stderr, 400)}`);
  const remote = result.stdout.trim();
  const match = remote.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) throw new Error(`Could not derive GitHub repository from origin: ${clean(remote, 300)}`);
  return `${match[1]}/${match[2]}`;
}

async function githubRequest(repo, token, apiPath, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${repo.split('/').map(encodeURIComponent).join('/')}${apiPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) throw new Error(`GitHub persistence failed (${response.status} ${response.statusText}): ${clean(typeof data === 'string' ? data : JSON.stringify(data), 800)}`);
  return data;
}

async function autoPersist(job, jobPath, files, hasBlocker) {
  if (hasBlocker) return { status: 'skipped-review-blocker' };
  if (job.persistence?.auto_commit === false) return { status: 'disabled-by-job' };

  const tokenEnv = job.persistence?.token_env || 'OX_GITHUB_WRITE_TOKEN';
  const token = process.env[tokenEnv];
  if (!token) return { status: 'not-configured', token_env: tokenEnv };

  const context = process.env.CONTEXT || '';
  if (!['deploy-preview', 'branch-deploy'].includes(context)) return { status: 'skipped-context', context };

  const repo = job.persistence?.repository || job.repository || process.env.OX_GITHUB_REPOSITORY || repositoryFromRemote();
  const branch = process.env.HEAD || process.env.BRANCH || '';
  const expectedSha = process.env.COMMIT_REF || '';
  if (!branch || !expectedSha) return { status: 'skipped-missing-netlify-ref' };
  if (/^(main|master)$/i.test(branch)) throw new Error('Auto-persist refuses to write directly to main/master.');

  const branchRef = branch.split('/').map(encodeURIComponent).join('/');
  const ref = await githubRequest(repo, token, `/git/ref/heads/${branchRef}`);
  const currentSha = ref?.object?.sha;
  if (!currentSha || currentSha !== expectedSha) {
    return { status: 'skipped-stale-head', expected_sha: expectedSha, actual_sha: currentSha || null };
  }

  const currentCommit = await githubRequest(repo, token, `/git/commits/${encodeURIComponent(currentSha)}`);
  const baseTree = currentCommit?.tree?.sha;
  if (!baseTree) throw new Error('Could not resolve the branch base tree for persistence.');

  const disabledJob = { ...job, enabled: false };
  const relativeJobPath = path.relative(root, jobPath).replaceAll(path.sep, '/');
  const persistenceFiles = {
    ...files,
    [relativeJobPath]: `${JSON.stringify(disabledJob, null, 2)}\n`,
  };

  const treeEntries = [];
  for (const [file, content] of Object.entries(persistenceFiles)) {
    const blob = await githubRequest(repo, token, '/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content, encoding: 'utf-8' }),
    });
    treeEntries.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const tree = await githubRequest(repo, token, '/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTree, tree: treeEntries }),
  });
  const commit = await githubRequest(repo, token, '/git/commits', {
    method: 'POST',
    body: JSON.stringify({
      message: `Persist validated Ox output: ${job.id}`,
      tree: tree.sha,
      parents: [currentSha],
    }),
  });
  await githubRequest(repo, token, `/git/refs/heads/${branchRef}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  return { status: 'persisted', repository: repo, branch, source_commit: currentSha, commit_sha: commit.sha };
}

function writeBundle(job, files, reviewText, meta, persistence) {
  fs.mkdirSync(oxDir, { recursive: true });
  const fileSha256 = Object.fromEntries(Object.entries(files).map(([file, content]) => [file, crypto.createHash('sha256').update(content).digest('hex')]));
  const bundle = {
    version: 1,
    job_id: job.id,
    source_commit: process.env.COMMIT_REF || '',
    generated_files: files,
    file_sha256: fileSha256,
    aggregate_sha256: aggregateHash(files),
    reviewer: {
      verdict: meta?.reviewer_verdict || null,
      has_blocker: /^BLOCKER:/im.test(reviewText),
      text: reviewText,
    },
    persistence,
    generated_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(oxDir, 'source-bundle.json'), JSON.stringify(bundle, null, 2));

  const updatedMeta = { ...meta, persistence, source_bundle: '/__ox/source-bundle.json' };
  fs.writeFileSync(path.join(oxDir, 'meta.json'), JSON.stringify(updatedMeta, null, 2));
}

const diagnosticPath = path.join(oxDir, 'diagnostic.json');
const metaPath = path.join(oxDir, 'meta.json');
if (fs.existsSync(diagnosticPath) || !fs.existsSync(metaPath)) {
  console.log('OX FINALIZER: no successful Ox build to persist.');
  process.exit(0);
}

try {
  const { job, fullPath: jobPath } = loadActiveJob();
  verifyGeneratedSource();
  const files = snapshot();
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const reviewPath = path.join(oxDir, 'review-reviewer.txt');
  const reviewText = fs.existsSync(reviewPath) ? fs.readFileSync(reviewPath, 'utf8') : '';
  const hasBlocker = /^BLOCKER:/im.test(reviewText);

  let persistence;
  try {
    persistence = await autoPersist(job, jobPath, files, hasBlocker);
  } catch (error) {
    persistence = { status: 'failed', message: clean(error?.message || error, 800) };
    console.error(`OX AUTO-PERSIST WARNING: ${persistence.message}`);
  }

  writeBundle(job, files, reviewText, meta, persistence);
  console.log(`OX FINALIZER PASS: source-bundle.json written; persistence=${persistence.status}`);
} catch (error) {
  const message = clean(error?.message || error, 900);
  fs.mkdirSync(oxDir, { recursive: true });
  fs.writeFileSync(path.join(oxDir, 'persistence-error.json'), JSON.stringify({ ok: false, message }, null, 2));
  console.error(`OX FINALIZER WARNING: ${message}`);
}
