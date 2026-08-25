import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const root = process.cwd();
const dist = path.join(root, 'dist');
const metaPath = path.join(dist, '__ox/meta.json');
const diagnosticPath = path.join(dist, '__ox/diagnostic.json');
if (!fs.existsSync(metaPath) || fs.existsSync(diagnosticPath)) process.exit(0);

const files = ['package.json', 'index.html', 'src/main.js', 'src/physics.js', 'src/mobile-controls.js'];
const source = Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
const reviewPath = path.join(dist, '__ox/review-reviewer.txt');
const review = fs.existsSync(reviewPath) ? fs.readFileSync(reviewPath, 'utf8') : '';
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const bundle = JSON.stringify({ version: 1, source_commit: process.env.COMMIT_REF || '', files: source, reviewer: review, meta });
const sha256 = crypto.createHash('sha256').update(bundle).digest('hex');
const compressed = zlib.gzipSync(Buffer.from(bundle, 'utf8'), { level: 9 });
const payload = compressed.toString('base64url');
const chunkSize = 1500;
const segmentSize = 150;
const chunks = [];
for (let offset = 0; offset < payload.length; offset += chunkSize) chunks.push(payload.slice(offset, offset + chunkSize));

const persistRoot = path.join(dist, '__persist');
fs.mkdirSync(persistRoot, { recursive: true });
const manifestName = `manifest-v1-${chunks.length}-${sha256}-${Buffer.byteLength(bundle)}-${compressed.length}.html`;
fs.writeFileSync(path.join(persistRoot, manifestName), '<!doctype html><meta charset="utf-8"><title>Ox persistence manifest</title>');

chunks.forEach((chunk, index) => {
  const parts = [];
  for (let offset = 0; offset < chunk.length; offset += segmentSize) parts.push(chunk.slice(offset, offset + segmentSize));
  const dir = path.join(persistRoot, `chunk-${String(index).padStart(3, '0')}`, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'payload.html'), '<!doctype html><meta charset="utf-8"><title>Ox persistence chunk</title>');
});

console.log(`OX PERSISTENCE PAYLOAD: chunks=${chunks.length} sha256=${sha256} jsonBytes=${Buffer.byteLength(bundle)} gzipBytes=${compressed.length}`);
