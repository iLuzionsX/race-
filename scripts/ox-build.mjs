import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const distDir = path.join(root, 'dist');
const jobPath = path.join(root, '.ox/jobs/mobile-physics-controls.json');
const endpoint = 'https://inference-api.nousresearch.com/v1/chat/completions';
const allFiles = ['package.json', 'index.html', 'src/main.js', 'src/physics.js', 'src/mobile-controls.js'];
const allowed = new Set(allFiles);
const THREE_VERSION = '0.185.1';
const VITE_VERSION = '8.2.2';
const MAX_ATTEMPTS = 3;

let stage = 'startup';
let job = null;
const rawByAgent = new Map();
const reviewByAgent = new Map();

function clean(value, max = 1600) {
  let text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  const key = process.env.NOUS_API_KEY;
  if (key) text = text.split(key).join('[REDACTED]');
  return text.slice(0, max);
}

function escapeHtml(value) {
  return clean(value, 6000)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function safeId(value) {
  return String(value || 'agent').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'agent';
}

function writeDiagnostic(error) {
  fs.mkdirSync(distDir, { recursive: true });
  const oxDir = path.join(distDir, '__ox');
  fs.mkdirSync(oxDir, { recursive: true });
  for (const [id, raw] of rawByAgent) {
    if (raw) fs.writeFileSync(path.join(oxDir, `raw-${safeId(id)}.txt`), raw);
  }
  for (const [id, review] of reviewByAgent) {
    if (review) fs.writeFileSync(path.join(oxDir, `review-${safeId(id)}.txt`), review);
  }
  const message = clean(error?.message || error);
  fs.writeFileSync(path.join(oxDir, 'diagnostic.json'), JSON.stringify({
    ok: false,
    stage,
    message,
    agents_with_output: [...rawByAgent.keys()],
    model: job?.model || '',
    context: process.env.CONTEXT || '',
    commit_ref: process.env.COMMIT_REF || '',
    generated_at: new Date().toISOString(),
  }, null, 2));
  fs.writeFileSync(path.join(distDir, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ox fan-out diagnostic</title><style>body{font:16px system-ui;background:#111;color:#eee;margin:0;padding:32px}main{max-width:900px;margin:auto}code,pre{background:#1d1d1d;padding:.2em .4em;border-radius:6px}pre{padding:16px;white-space:pre-wrap}.bad{color:#ff8b8b}</style><main><h1>Ox fan-out diagnostic</h1><p class="bad">The mobile physics/control build stopped at <strong>${escapeHtml(stage)}</strong>.</p><pre>${escapeHtml(message)}</pre><p>Commit: <code>${escapeHtml(process.env.COMMIT_REF || '')}</code></p><p>Per-agent raw output is under <code>/__ox/raw-&lt;agent&gt;.txt</code>.</p></main>`);
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function protocolFor(files) {
  return files.map(file => `<<<OX_FILE:${file}>>>\n[complete ${file}]\n<<<OX_END_FILE>>>`).join('\n');
}

function parseFileBlocks(raw, expectedFiles) {
  const expected = new Set(expectedFiles);
  const normalized = String(raw || '').replace(/\r\n/g, '\n').trim();
  const blockRe = /^<<<OX_FILE:([^\n>]+)>>>\n([\s\S]*?)\n<<<OX_END_FILE>>>$/gm;
  const found = new Map();
  let cursor = 0;
  let match;
  while ((match = blockRe.exec(normalized)) !== null) {
    if (normalized.slice(cursor, match.index).trim()) throw new Error('Ox output contained text outside file blocks.');
    const file = match[1].trim();
    if (!expected.has(file)) throw new Error(`Ox returned undeclared file block: ${file}`);
    if (found.has(file)) throw new Error(`Ox returned duplicate file block: ${file}`);
    if (match[2].includes('<<<OX_FILE:') || match[2].includes('<<<OX_END_FILE>>>')) throw new Error(`Reserved Ox marker appeared inside ${file}.`);
    found.set(file, `${match[2]}\n`);
    cursor = blockRe.lastIndex;
  }
  if (normalized.slice(cursor).trim()) throw new Error('Ox output contained trailing text outside file blocks.');
  for (const file of expectedFiles) if (!found.has(file)) throw new Error(`Ox did not return required file block: ${file}`);
  if (found.size !== expectedFiles.length) throw new Error('Unexpected Ox file-block count.');
  return found;
}

function parseReview(raw) {
  const normalized = String(raw || '').replace(/\r\n/g, '\n').trim();
  const match = normalized.match(/^<<<OX_REVIEW>>>\n([\s\S]*?)\n<<<OX_END_REVIEW>>>$/);
  if (!match) throw new Error('Reviewer did not follow the review block protocol.');
  const review = match[1].trim();
  const verdict = review.match(/^VERDICT:\s*(PASS|FAIL)\b/im)?.[1]?.toUpperCase();
  if (!verdict) throw new Error('Reviewer omitted VERDICT: PASS or VERDICT: FAIL.');
  return { verdict, review };
}

function selectedFiles(fileList) {
  return fileList.map(file => ({ path: file, content: fs.readFileSync(path.join(root, file), 'utf8') }));
}

async function callOx(agent, inputFiles, apiKey, extraContext = '') {
  const id = agent.id;
  const mode = agent.mode || 'files';
  const system = mode === 'review'
    ? [
        `You are Ox Alpha agent ${id}, acting only as an independent senior reviewer/QA engineer.`,
        'Do not modify files and do not return code blocks.',
        'Return exactly one review block using this protocol:',
        '<<<OX_REVIEW>>>',
        'VERDICT: PASS or VERDICT: FAIL',
        '[concise findings, with blockers first]',
        '<<<OX_END_REVIEW>>>',
        'PASS only when there is no blocker likely to break build/runtime, mobile simultaneous controls, or the requested vehicle behavior.',
      ].join('\n')
    : [
        `You are Ox Alpha agent ${id}, a narrowly scoped implementation engineer.`,
        'The supplied repository files and interface contract are authoritative.',
        `You may author ONLY these files: ${agent.files.join(', ')}.`,
        'Return the COMPLETE final contents of exactly those files using the exact file-block protocol below.',
        'Do not return a diff, Markdown fences, prose outside the blocks, renames, new files, or deleted files.',
        protocolFor(agent.files),
      ].join('\n');

  const fileText = selectedFiles(inputFiles).map(file => `\n===== CURRENT FILE: ${file.path} =====\n${file.content}\n===== END CURRENT FILE: ${file.path} =====`).join('\n');
  const userContent = `TASK\n${agent.task}\n\nREPOSITORY CONTEXT${fileText}${extraContext ? `\n\nADDITIONAL ORCHESTRATOR CONTEXT\n${extraContext}` : ''}`;

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600_000);
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        signal: controller.signal,
        body: JSON.stringify({
          model: agent.model || job.model || 'stealth/ox-alpha',
          messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }],
          reasoning_effort: agent.reasoning_effort || job.reasoning_effort || 'medium',
          include_reasoning: false,
          max_tokens: agent.max_tokens || job.max_tokens || 16000,
          stream: true,
          tags: ['product=race', 'workflow=ox-fanout-mobile', `agent=${safeId(id)}`],
        }),
      });
      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        clearTimeout(timeout);
        const retryable = response.status === 429 || response.status >= 500;
        lastError = new Error(`Nous/Ox ${id} request failed (${response.status}): ${clean(raw, 700)}`);
        if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;
        await sleep(1000 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 500));
        continue;
      }
      const raw = await readOxResponse(response, controller, timeout);
      rawByAgent.set(id, raw);
      return raw;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt === MAX_ATTEMPTS) throw error;
      await sleep(1000 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 500));
    }
  }
  throw lastError || new Error(`Ox agent ${id} failed.`);
}

function verifyManifest() {
  stage = 'manifest-verify';
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dependencies = pkg.dependencies || {};
  const devDependencies = pkg.devDependencies || {};
  const depKeys = Object.keys(dependencies).sort();
  const devDepKeys = Object.keys(devDependencies).sort();
  if (JSON.stringify(depKeys) !== JSON.stringify(['three'])) throw new Error(`Dependencies must be exactly [three], got ${depKeys.join(', ') || '(none)'}.`);
  if (JSON.stringify(devDepKeys) !== JSON.stringify(['vite'])) throw new Error(`Dev dependencies must be exactly [vite], got ${devDepKeys.join(', ') || '(none)'}.`);
  if (dependencies.three !== THREE_VERSION) throw new Error(`three must be pinned to ${THREE_VERSION}.`);
  if (devDependencies.vite !== VITE_VERSION) throw new Error(`vite must be pinned to ${VITE_VERSION}.`);
  const scripts = pkg.scripts || {};
  const allowedScripts = new Set(['build', 'dev', 'preview']);
  for (const name of Object.keys(scripts)) if (!allowedScripts.has(name)) throw new Error(`Generated package.json may not define script: ${name}`);
  if (scripts.build !== 'vite build') throw new Error('package.json build script must be exactly "vite build".');
  if (scripts.dev && scripts.dev !== 'vite') throw new Error('dev script must be exactly "vite".');
  if (scripts.preview && scripts.preview !== 'vite preview') throw new Error('preview script must be exactly "vite preview".');
}

function verifySources() {
  stage = 'source-verify';
  for (const file of ['index.html', 'src/main.js', 'src/physics.js', 'src/mobile-controls.js']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (!text.trim()) throw new Error(`Generated ${file} is empty.`);
    if (/https?:\/\//i.test(text)) throw new Error(`Generated ${file} may not reference external URLs.`);
  }
  const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  if (!main.includes('./physics.js')) throw new Error('src/main.js must import ./physics.js.');
  if (!main.includes('./mobile-controls.js')) throw new Error('src/main.js must import ./mobile-controls.js.');
}

function validateJob() {
  if (!job.enabled) throw new Error('Ox fan-out job is disabled.');
  if (!Array.isArray(job.agents) || job.agents.length < 4) throw new Error('Expected at least four Ox agents.');
  const ids = new Set();
  for (const agent of job.agents) {
    if (!agent.id || ids.has(agent.id)) throw new Error(`Invalid or duplicate agent id: ${agent.id}`);
    ids.add(agent.id);
    if (!Array.isArray(agent.context_files) || agent.context_files.some(file => !allowed.has(file))) throw new Error(`Agent ${agent.id} has invalid context_files.`);
    if ((agent.mode || 'files') === 'files') {
      if (!Array.isArray(agent.files) || !agent.files.length || agent.files.some(file => !allowed.has(file))) throw new Error(`Agent ${agent.id} has invalid output files.`);
    }
  }
  for (const file of allFiles) if (!fs.statSync(path.join(root, file)).isFile()) throw new Error(`Missing Ox target/context file: ${file}`);
}

async function runFileAgent(agent, apiKey, extraContext = '') {
  stage = `agent-${agent.id}`;
  const raw = await callOx(agent, agent.context_files, apiKey, extraContext);
  const authored = parseFileBlocks(raw, agent.files);
  for (const file of agent.files) fs.writeFileSync(path.join(root, file), authored.get(file), 'utf8');
  return authored;
}

async function main() {
  stage = 'job-load';
  job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  const apiKey = process.env.NOUS_API_KEY;
  if (!apiKey) throw new Error('NOUS_API_KEY is not configured for this Netlify deploy context.');
  validateJob();

  const byId = new Map(job.agents.map(agent => [agent.id, agent]));
  const physics = byId.get('physics');
  const controls = byId.get('controls');
  const integrator = byId.get('integrator');
  const reviewer = byId.get('reviewer');
  if (!physics || !controls || !integrator || !reviewer) throw new Error('Required agent ids: physics, controls, integrator, reviewer.');

  stage = 'parallel-specialists';
  await Promise.all([
    runFileAgent(physics, apiKey),
    runFileAgent(controls, apiKey),
  ]);

  stage = 'integrator';
  await runFileAgent(integrator, apiKey, [
    'The physics and mobile-control modules above were independently authored by specialist Ox agents and are now authoritative inputs.',
    'Integrate them rather than rewriting their responsibilities into main.js.',
  ].join('\n'));

  verifyManifest();
  verifySources();

  stage = 'dependency-install';
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], 180_000);

  stage = 'vite-build';
  run(path.join(root, 'node_modules/.bin/vite'), ['build'], 180_000);

  stage = 'reviewer';
  const reviewRaw = await callOx(reviewer, reviewer.context_files, apiKey, 'The Vite production build has already completed successfully. Review source/runtime logic, mobile ergonomics, and the requested behavior.');
  const parsedReview = parseReview(reviewRaw);
  reviewByAgent.set(reviewer.id, parsedReview.review);
  if (parsedReview.verdict !== 'PASS') throw new Error(`Ox reviewer rejected the build:\n${clean(parsedReview.review, 1400)}`);

  stage = 'artifact-write';
  const oxOut = path.join(distDir, '__ox');
  const generatedDir = path.join(oxOut, 'generated');
  fs.mkdirSync(generatedDir, { recursive: true });
  for (const [id, raw] of rawByAgent) fs.writeFileSync(path.join(oxOut, `raw-${safeId(id)}.txt`), raw);
  for (const [id, review] of reviewByAgent) fs.writeFileSync(path.join(oxOut, `review-${safeId(id)}.txt`), review);
  for (const file of allFiles) {
    const destination = path.join(generatedDir, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, file), destination);
  }
  const diffResult = spawnSync('git', ['diff', '--no-ext-diff', '--', ...allFiles], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (diffResult.error || diffResult.status !== 0) throw diffResult.error || new Error('git diff generation failed.');
  fs.writeFileSync(path.join(oxOut, 'mobile-physics-controls.diff'), diffResult.stdout);
  fs.writeFileSync(path.join(oxOut, 'meta.json'), JSON.stringify({
    ok: true,
    model: job.model,
    fanout: ['physics', 'controls'],
    sequential: ['integrator', 'reviewer'],
    reviewer_verdict: parsedReview.verdict,
    generated_files: allFiles,
    netlify_context: process.env.CONTEXT || '',
    commit_ref: process.env.COMMIT_REF || '',
    generated_at: new Date().toISOString(),
  }, null, 2));
  console.log('OX FANOUT BUILD PASS: physics + controls -> integrator -> reviewer');
}

try {
  await main();
} catch (error) {
  writeDiagnostic(error);
}
