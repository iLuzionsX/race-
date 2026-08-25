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

function base32Lower(buffer) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '', value = 0, bits = 0;
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
      value &= (1 << bits) - 1;
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

const payload = base32Lower(compressed);
const chunkCount = 8;
const chunkSize = Math.ceil(payload.length / chunkCount);
const chunks = Array.from({ length: chunkCount }, (_, index) => payload.slice(index * chunkSize, (index + 1) * chunkSize));
const segmentSize = 180;

chunks.forEach((chunk, index) => {
  const idx = String(index).padStart(3, '0');
  const meta = index === 0 ? `p9-${idx}-${sha256}-${bundle.length}-${compressed.length}` : `p9-${idx}`;
  const segments = [];
  for (let offset = 0; offset < chunk.length; offset += segmentSize) segments.push(chunk.slice(offset, offset + segmentSize));
  const dir = path.join(dist, meta, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Ox persistence v9 ${idx}</title><p>${idx}</p>`);
});
console.log(`OX PERSISTENCE V9: chunks=${chunkCount} sha256=${sha256} rawBytes=${bundle.length} brotliBytes=${compressed.length}`);
