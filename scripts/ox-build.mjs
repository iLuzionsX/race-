import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const jobPath = path.join(root, '.ox/jobs/threejs-world.json');
const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
const apiKey = process.env.NOUS_API_KEY;
const endpoint = 'https://inference-api.nousresearch.com/v1/chat/completions';

if (!job.enabled) throw new Error('Ox job is disabled.');
if (!apiKey) throw new Error('NOUS_API_KEY is not configured for this Netlify site.');
if (!Array.isArray(job.files) || job.files.length !== 3) throw new Error('Unexpected Ox file scope.');

const allowed = new Set(['package.json', 'index.html', 'src/main.js']);
for (const file of job.files) {
  if (!allowed.has(file)) throw new Error(`Undeclared Ox target: ${file}`);
  if (!fs.statSync(path.join(root, file)).isFile()) throw new Error(`Missing Ox target: ${file}`);
}

const selected = job.files.map(file => ({
  path: file,
  content: fs.readFileSync(path.join(root, file), 'utf8'),
}));

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
} finally {
  clearTimeout(timeout);
}

if (!response.ok) {
  const raw = await response.text().catch(() => '');
  throw new Error(`Nous/Ox request failed (${response.status}): ${raw.slice(0, 600)}`);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof part === 'string' ? part : (part?.text || part?.content || '')).join('');
}

let output = '';
const contentType = response.headers.get('content-type') || '';
if (contentType.includes('application/json')) {
  const data = await response.json();
  output = contentText(data?.choices?.[0]?.message?.content);
} else {
  if (!response.body?.getReader) throw new Error('Ox returned no readable stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
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
}

output = String(output || '').replace(/\r\n/g, '\n').trim();
const fenced = output.match(/```(?:diff|patch)?\s*\n([\s\S]*?)\n```/i);
if (fenced) output = fenced[1].trim();
const diffStart = output.search(/^diff --git /m);
if (diffStart < 0) throw new Error('Ox did not return a git-style unified diff.');
output = `${output.slice(diffStart).trim()}\n`;
if (/^```/m.test(output) || /^GIT binary patch$/m.test(output)) throw new Error('Unsafe Ox patch format.');

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

for (const required of allowed) {
  if (!changed.has(required)) throw new Error(`Ox patch did not modify required file: ${required}`);
}

const check = spawnSync('git', ['apply', '--check', '--whitespace=nowarn', '-'], {
  cwd: root,
  input: output,
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
});
if (check.status !== 0) throw new Error(`Ox patch failed git apply --check: ${String(check.stderr || check.stdout).slice(0, 800)}`);

const applied = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], {
  cwd: root,
  input: output,
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
});
if (applied.status !== 0) throw new Error(`Ox patch failed to apply: ${String(applied.stderr || applied.stdout).slice(0, 800)}`);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dependencyNames = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})];
for (const dep of dependencyNames) {
  if (!['three', 'vite'].includes(dep)) throw new Error(`Ox introduced undeclared dependency: ${dep}`);
}
if (!dependencyNames.includes('three') || !dependencyNames.includes('vite')) throw new Error('Ox must use Three.js and Vite.');
if (pkg.scripts?.build !== 'vite build') throw new Error('Ox package.json must use "vite build" as the build script.');
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly']) {
  if (pkg.scripts?.[hook]) throw new Error(`Ox may not define lifecycle script: ${hook}`);
}

for (const file of ['index.html', 'src/main.js']) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  if (/https?:\/\//i.test(text)) throw new Error(`Ox may not reference external URLs in ${file}.`);
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

run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], 180_000);
run('npm', ['run', 'build'], 180_000);

const oxOut = path.join(root, 'dist', '__ox');
fs.mkdirSync(oxOut, { recursive: true });
fs.writeFileSync(path.join(oxOut, 'threejs-world.diff'), output);
fs.writeFileSync(path.join(oxOut, 'meta.json'), JSON.stringify({
  model: job.model,
  reasoning_effort: job.reasoning_effort,
  changed_files: [...changed].sort(),
  netlify_context: process.env.CONTEXT || '',
  commit_ref: process.env.COMMIT_REF || '',
  generated_at: new Date().toISOString(),
}, null, 2));

console.log(`OX BUILD PASS: ${[...changed].sort().join(', ')}`);
