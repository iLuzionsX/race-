import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const distDir = path.join(root, 'dist');
const jobPath = path.join(root, '.ox/jobs/threejs-world.json');
const endpoint = 'https://inference-api.nousresearch.com/v1/chat/completions';
const allowed = new Set(['package.json', 'index.html', 'src/main.js']);
const THREE_VERSION = '0.185.1';
const VITE_VERSION = '8.2.2';

let stage = 'startup';
let rawOxOutput = '';
let job = null;

function clean(value, max = 1200) {
  let text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  const key = process.env.NOUS_API_KEY;
  if (key) text = text.split(key).join('[REDACTED]');
  return text.slice(0, max);
}

function escapeHtml(value) {
  return clean(value, 5000)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function writeDiagnostic(error) {
  fs.mkdirSync(distDir, { recursive: true });
  const oxDir = path.join(distDir, '__ox');
  fs.mkdirSync(oxDir, { recursive: true });
  if (rawOxOutput) fs.writeFileSync(path.join(oxDir, 'raw-output.txt'), rawOxOutput);
  const message = clean(error?.message || error);
  fs.writeFileSync(path.join(oxDir, 'diagnostic.json'), JSON.stringify({
    ok: false,
    stage,
    message,
    model: job?.model || '',
    context: process.env.CONTEXT || '',
    commit_ref: process.env.COMMIT_REF || '',
    generated_at: new Date().toISOString(),
  }, null, 2));
  fs.writeFileSync(path.join(distDir, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ox delegation diagnostic</title><style>body{font:16px system-ui;background:#111;color:#eee;margin:0;padding:32px}main{max-width:900px;margin:auto}code,pre{background:#1d1d1d;padding:.2em .4em;border-radius:6px}pre{padding:16px;white-space:pre-wrap}.bad{color:#ff8b8b}</style><main><h1>Ox delegation diagnostic</h1><p class="bad">The Three.js implementation was not published because the Ox pipeline stopped at <strong>${escapeHtml(stage)}</strong>.</p><pre>${escapeHtml(message)}</pre><p>Commit: <code>${escapeHtml(process.env.COMMIT_REF || '')}</code></p><p>Raw Ox output, if any, is available at <code>/__ox/raw-output.txt</code>.</p></main>`);
  console.error(`OX DIAGNOSTIC: ${stage}: ${message}`);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof part === 'string' ? part : (part?.text || part?.content || '')).join('');
}

function run(command, args, timeoutMs) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    timeout: timeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
}

async function readOxResponse(response, controller, timeout) {
  try {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await response.json();
      return contentText(data?.choices?.[0]?.message?.content);
    }
    if (!response.body?.getReader) throw new Error('Ox returned no readable stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let output = '';
    let buffer = '';
    const consume = block => {
      const payloadText = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
      if (!payloadText || payloadText === '[DONE]') return;
      let payload;
      try { payload = JSON.parse(payloadText); } catch { return; }
      const choice = payload?.choices?.[0];
      output += contentText(choice?.delta?.content) || (typeof choice?.text === 'string' ? choice.text : '');
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        consume(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    return output;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function main() {
  stage = 'job-load';
  job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  const apiKey = process.env.NOUS_API_KEY;
  if (!job.enabled) throw new Error('Ox job is disabled.');
  if (!apiKey) throw new Error('NOUS_API_KEY is not configured for this Netlify deploy context.');
  if (!Array.isArray(job.files) || job.files.length !== 3) throw new Error('Unexpected Ox file scope.');
  for (const file of job.files) {
    if (!allowed.has(file)) throw new Error(`Undeclared Ox target: ${file}`);
    if (!fs.statSync(path.join(root, file)).isFile()) throw new Error(`Missing Ox target: ${file}`);
  }

  stage = 'prompt-build';
  const selected = job.files.map(file => ({ path: file, content: fs.readFileSync(path.join(root, file), 'utf8') }));
  const system = [
    'You are Ox Alpha, acting as the sole implementation engineer for a tightly scoped Three.js demo.',
    'The supplied repository files are authoritative.',
    'Implement the requested demo only inside the declared files.',
    'Return ONLY a canonical git-style unified diff that applies from repository root.',
    'Do not use Markdown fences, prose, renames, new files, deleted files, binary patches, or changes outside the declared files.',
  ].join('\n');
  const filesText = selected.map(file => `\n===== FILE: ${file.path} =====\n${file.content}\n===== END FILE: ${file.path} =====`).join('\n');
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `TASK\n${job.task}\n\nSELECTED REPOSITORY FILES${filesText}` },
  ];

  stage = 'ox-request';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600_000);
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: job.model || 'stealth/ox-alpha',
        messages,
        reasoning_effort: job.reasoning_effort || 'medium',
        include_reasoning: false,
        max_tokens: job.max_tokens || 16000,
        stream: true,
        tags: ['product=race', 'workflow=ox-only-threejs-test'],
      }),
    });
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    clearTimeout(timeout);
    throw new Error(`Nous/Ox request failed (${response.status}): ${clean(raw, 600)}`);
  }

  stage = 'ox-stream';
  rawOxOutput = await readOxResponse(response, controller, timeout);

  stage = 'patch-parse';
  let output = String(rawOxOutput || '').replace(/\r\n/g, '\n').trim();
  const fenced = output.match(/```(?:diff|patch)?\s*\n([\s\S]*?)\n```/i);
  if (fenced) output = fenced[1].trim();
  const diffStart = output.search(/^diff --git /m);
  if (diffStart < 0) throw new Error('Ox did not return a git-style unified diff.');
  output = `${output.slice(diffStart).trim()}\n`;
  rawOxOutput = output;
  if (/^```/m.test(output) || /^GIT binary patch$/m.test(output)) throw new Error('Unsafe Ox patch format.');

  stage = 'scope-verify';
  const changed = new Set();
  let pendingOld = null;
  for (const line of output.split('\n')) {
    const diff = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (diff) {
      if (diff[1] !== diff[2]) throw new Error(`Renames are not allowed: ${line}`);
      if (!allowed.has(diff[2])) throw new Error(`Ox touched an undeclared file: ${diff[2]}`);
      changed.add(diff[2]);
    }
    const minus = line.match(/^---\s+(.+)$/);
    if (minus) {
      if (minus[1] === '/dev/null') throw new Error('Ox may not create files.');
      pendingOld = minus[1].replace(/^a\//, '').split('\t')[0];
    }
    const plus = line.match(/^\+\+\+\s+(.+)$/);
    if (plus) {
      if (plus[1] === '/dev/null') throw new Error('Ox may not delete files.');
      const next = plus[1].replace(/^b\//, '').split('\t')[0];
      if (pendingOld && pendingOld !== next) throw new Error(`Rename detected: ${pendingOld} -> ${next}`);
      if (!allowed.has(next)) throw new Error(`Ox touched an undeclared file: ${next}`);
      changed.add(next);
      pendingOld = null;
    }
  }
  for (const required of allowed) if (!changed.has(required)) throw new Error(`Ox patch did not modify required file: ${required}`);

  stage = 'patch-check';
  const check = spawnSync('git', ['apply', '--check', '--whitespace=nowarn', '-'], { cwd: root, input: output, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (check.status !== 0) throw new Error(`Ox patch failed git apply --check: ${clean(check.stderr || check.stdout, 800)}`);
  const applied = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: root, input: output, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (applied.status !== 0) throw new Error(`Ox patch failed to apply: ${clean(applied.stderr || applied.stdout, 800)}`);

  stage = 'manifest-verify';
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dependencies = pkg.dependencies || {};
  const devDependencies = pkg.devDependencies || {};
  const depKeys = Object.keys(dependencies).sort();
  const devDepKeys = Object.keys(devDependencies).sort();
  if (JSON.stringify(depKeys) !== JSON.stringify(['three'])) throw new Error(`Ox dependencies must be exactly [three], got ${depKeys.join(', ') || '(none)'}.`);
  if (JSON.stringify(devDepKeys) !== JSON.stringify(['vite'])) throw new Error(`Ox devDependencies must be exactly [vite], got ${devDepKeys.join(', ') || '(none)'}.`);
  if (dependencies.three !== THREE_VERSION) throw new Error(`Ox must pin three to ${THREE_VERSION}.`);
  if (devDependencies.vite !== VITE_VERSION) throw new Error(`Ox must pin vite to ${VITE_VERSION}.`);
  const scripts = pkg.scripts || {};
  const allowedScripts = new Set(['build', 'dev', 'preview']);
  for (const name of Object.keys(scripts)) if (!allowedScripts.has(name)) throw new Error(`Ox may not define script: ${name}`);
  if (scripts.build !== 'vite build') throw new Error('Ox package.json must use "vite build" as the build script.');
  if (scripts.dev && scripts.dev !== 'vite') throw new Error('Ox dev script must be exactly "vite".');
  if (scripts.preview && scripts.preview !== 'vite preview') throw new Error('Ox preview script must be exactly "vite preview".');

  stage = 'source-verify';
  for (const file of ['index.html', 'src/main.js']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (/https?:\/\//i.test(text)) throw new Error(`Ox may not reference external URLs in ${file}.`);
  }

  stage = 'dependency-install';
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], 180_000);

  stage = 'vite-build';
  run(path.join(root, 'node_modules/.bin/vite'), ['build'], 180_000);

  stage = 'artifact-write';
  const oxOut = path.join(distDir, '__ox');
  fs.mkdirSync(oxOut, { recursive: true });
  fs.writeFileSync(path.join(oxOut, 'threejs-world.diff'), output);
  fs.writeFileSync(path.join(oxOut, 'meta.json'), JSON.stringify({
    ok: true,
    model: job.model,
    reasoning_effort: job.reasoning_effort,
    changed_files: [...changed].sort(),
    netlify_context: process.env.CONTEXT || '',
    commit_ref: process.env.COMMIT_REF || '',
    generated_at: new Date().toISOString(),
  }, null, 2));
  console.log(`OX BUILD PASS: ${[...changed].sort().join(', ')}`);
}

try {
  await main();
} catch (error) {
  writeDiagnostic(error);
}
