import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.cwd(), 'dist/__ox/diagnostic.json');
if (!fs.existsSync(file)) process.exit(0);

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const slug = value => String(value ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80) || 'unknown';
const name = `error-${slug(data.stage)}-${slug(data.message)}.html`;
fs.writeFileSync(path.join(process.cwd(), 'dist', name), '<!doctype html><meta charset="utf-8"><title>Ox diagnostic marker</title>');
console.log(`OX DIAGNOSTIC MARKER: ${name}`);
