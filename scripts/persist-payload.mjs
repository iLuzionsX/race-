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
const framed = [];
for (const file of files) {
  const bytes = fs.readFileSync(path.join(root, file));
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length, 0);
  framed.push(length, bytes);
}
const bundle = Buffer.concat(framed);
const sha256 = crypto.createHash('sha256').update(bundle).digest('hex');
const compressed = zlib.brotliCompressSync(bundle, {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
  },
});
const payload = compressed.toString('base64url');
const chunkSize = 230;
const chunks = [];
for (let offset = 0; offset < payload.length; offset += chunkSize) chunks.push(payload.slice(offset, offset + chunkSize));

for (const entry of fs.readdirSync(dist)) {
  if (/^p3-(?:manifest|\d{3})-/.test(entry)) fs.rmSync(path.join(dist, entry), { force: true });
}
const manifest = `p3-manifest-${chunks.length}-${sha256}-${bundle.length}-${compressed.length}.html`;
fs.writeFileSync(path.join(dist, manifest), '<!doctype html><meta charset="utf-8"><title>Ox persistence v3</title>');
chunks.forEach((chunk, index) => {
  const name = `p3-${String(index).padStart(3, '0')}-${chunk}.html`;
  fs.writeFileSync(path.join(dist, name), '<!doctype html><meta charset="utf-8"><title>Ox persistence chunk</title>');
});
console.log(`OX PERSISTENCE V3: chunks=${chunks.length} sha256=${sha256} rawBytes=${bundle.length} brotliBytes=${compressed.length}`);
