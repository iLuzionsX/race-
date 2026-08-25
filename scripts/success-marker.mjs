import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const metaPath = path.join(root, 'dist/__ox/meta.json');
const diagnosticPath = path.join(root, 'dist/__ox/diagnostic.json');
if (!fs.existsSync(metaPath) || fs.existsSync(diagnosticPath)) process.exit(0);

const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const verdict = String(meta.reviewer_verdict || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-');
const name = `success-ox-fanout-review-${verdict || 'unknown'}.html`;
fs.writeFileSync(path.join(root, 'dist', name), '<!doctype html><meta charset="utf-8"><title>Ox fan-out success marker</title>');
console.log(`OX SUCCESS MARKER: ${name}`);
