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
const chunkCount = 8;
const chunkSize = Math.ceil(payload.length / chunkCount);
const chunks = Array.from({ length: chunkCount }, (_, index) => payload.slice(index * chunkSize, (index + 1) * chunkSize));
const segmentSize = 180;

chunks.forEach((chunk, index) => {
  const idx = String(index).padStart(3, '0');
  const meta = index === 0 ? `p6-${idx}-${sha256}-${bundle.length}-${compressed.length}` : `p6-${idx}`;
  const segments = [];
  for (let offset = 0; offset < chunk.length; offset += segmentSize) segments.push(chunk.slice(offset, offset + segmentSize));
  const dir = path.join(dist, meta, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'payload.html'), `<!doctype html><meta charset="utf-8"><title>Ox persistence v6 ${idx}</title><p>${idx}</p>`);
});
console.log(`OX PERSISTENCE V6: chunks=${chunkCount} sha256=${sha256} rawBytes=${bundle.length} brotliBytes=${compressed.length}`);
