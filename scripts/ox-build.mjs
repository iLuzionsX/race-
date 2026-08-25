import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const distDir = path.join(root, 'dist');
const jobPath = path.join(root, '.ox/jobs/threejs-world.json');
const endpoint = 'https://inference-api.nousresearch.com/v1/chat/completions';
const files = ['package.json', 'index.html', 'src/main.js'];
const allowed = new Set(files);
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
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false, timeout: timeoutMs });
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
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
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

function parseFileBlocks(raw) {
  const normalized = String(raw || '').replace(/\r\n/g, '\n').trim();
  const blockRe = /^<<<OX_FILE:([^\n>]+)>>>\n([\s\S]*?)\n<<<OX_END_FILE>>>$/gm;
  const found = new Map();
  let cursor = 0;
  let match;
  while ((match = blockRe.exec(normalized)) !== null) {
    if (normalized.slice(cursor, match.index).trim()) throw new Error('Ox output contained text outside file blocks.');
    const file = match[1].trim();
    if (!allowed.has(file)) throw new Error(`Ox returned undeclared file block: ${file}`);
    if (found.has(file)) throw new Error(`Ox returned duplicate file block: ${file}`);
    if (match[2].includes('<<<OX_FILE:') || match[2].includes('<<<OX_END_FILE>>>')) throw new Error(`Reserved Ox marker appeared inside ${file}.`);
    found.set(file, `${match[2]}\n`);
    cursor = blockRe.lastIndex;
  }
  if (normalized.slice(cursor).trim()) throw new Error('Ox output contained trailing text outside file blocks.');
  for (const file of files) if (!found.has(file)) throw new Error(`Ox did not return required file block: ${file}`);
  if (found.size !== files.length) throw new Error('Unexpected Ox file-block count.');
  return found;
}

function verifyManifest() {
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
}

async function main() {
  stage = 'job-load';
  job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  const apiKey = process.env.NOUS_API_KEY;
  if (!job.enabled) throw new Error('Ox job is disabled.');
  if (!apiKey) throw new Error('NOUS_API_KEY is not configured for this Netlify deploy context.');
  if (!Array.isArray(job.files) || job.files.length !== files.length) throw new Error('Unexpected Ox file scope.');
  if (job.files.some(file => !allowed.has(file))) throw new Error('Ox job declares an undeclared file.');
  for (const file of files) if (!fs.statSync(path.join(root, file)).isFile()) throw new Error(`Missing Ox target: ${file}`);

  stage = 'prompt-build';
  const selected = files.map(file => ({ path: file, content: fs.readFileSync(path.join(root, file), 'utf8') }));
  const system = [
    'You are Ox Alpha, the sole implementation engineer for this tightly scoped Three.js demo.',
    'The supplied repository files are authoritative. Implement the requested demo only inside the three declared files.',
    'Do NOT return a diff. Return the COMPLETE final contents of exactly the three files using the exact block protocol below.',
    'Each marker must be on its own line. Do not use Markdown fences or prose. Do not omit, rename, add, or delete files.',
    'Protocol:',
    '<<<OX_FILE:package.json>>>',
    '[complete package.json]',
    '<<<OX_END_FILE>>>',
    '<<<OX_FILE:index.html>>>',
    '[complete index.html]',
    '<<<OX_END_FILE>>>',
    '<<<OX_FILE:src/main.js>>>',
    '[complete src/main.js]',
    '<<<OX_END_FILE>>>',
  ].join('\n');
  const filesText = selected.map(file => `\n===== CURRENT FILE: ${file.path} =====\n${file.content}\n===== END CURRENT FILE: ${file.path} =====`).join('\n');
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `TASK\n${job.task}\n\nCURRENT REPOSITORY FILES${filesText}` },
  ];

  stage = 'ox-request';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600_000);
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      signal: controller.signal,
      body: JSON.stringify({
        model: job.model || 'stealth/ox-alpha',
        messages,
        reasoning_effort: job.reasoning_effort || 'medium',
        include_reasoning: false,
        max_tokens: job.max_tokens || 16000,
        stream: true,
        tags: ['product=race', 'workflow=ox-only-threejs-full-files'],
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

  stage = 'file-block-parse';
  const authored = parseFileBlocks(rawOxOutput);

  stage = 'file-write';
  for (const file of files) fs.writeFileSync(path.join(root, file), authored.get(file), 'utf8');

  verifyManifest();

  stage = 'source-verify';
  for (const file of ['index.html', 'src/main.js']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (/https?:\/\//i.test(text)) throw new Error(`Ox may not reference external URLs in ${file}.`);
    if (!text.trim()) throw new Error(`Ox returned empty ${file}.`);
  }

  stage = 'diff-generate';
  const names = spawnSync('git', ['diff', '--name-only', '--', ...files], { cwd: root, encoding: 'utf8' });
  if (names.error || names.status !== 0) throw names.error || new Error('git diff --name-only failed.');
  const changed = names.stdout.trim().split('\n').filter(Boolean).sort();
  const expected = [...files].sort();
  if (JSON.stringify(changed) !== JSON.stringify(expected)) throw new Error(`Ox must modify exactly ${expected.join(', ')}; got ${changed.join(', ') || '(none)'}.`);
  const diffResult = spawnSync('git', ['diff', '--no-ext-diff', '--', ...files], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (diffResult.error || diffResult.status !== 0) throw diffResult.error || new Error('git diff generation failed.');
  const canonicalDiff = diffResult.stdout;
  if (!canonicalDiff.trim()) throw new Error('Generated Ox diff is empty.');

  stage = 'dependency-install';
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], 180_000);

  stage = 'vite-build';
  run(path.join(root, 'node_modules/.bin/vite'), ['build'], 180_000);

  stage = 'artifact-write';
  const oxOut = path.join(distDir, '__ox');
  fs.mkdirSync(oxOut, { recursive: true });
  fs.writeFileSync(path.join(oxOut, 'threejs-world.diff'), canonicalDiff);
  fs.writeFileSync(path.join(oxOut, 'raw-output.txt'), rawOxOutput);
  fs.writeFileSync(path.join(oxOut, 'meta.json'), JSON.stringify({
    ok: true,
    model: job.model,
    reasoning_effort: job.reasoning_effort,
    changed_files: changed,
    output_protocol: 'full-files-v1',
    netlify_context: process.env.CONTEXT || '',
    commit_ref: process.env.COMMIT_REF || '',
    generated_at: new Date().toISOString(),
  }, null, 2));
  console.log(`OX BUILD PASS: ${changed.join(', ')}`);
}

try {
  await main();
} catch (error) {
  writeDiagnostic(error);
}
