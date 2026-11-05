import { readFile, access, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
for (const key of ['display_name', 'js', 'author', 'version']) if (!manifest[key]) throw new Error(`Missing ${key}`);
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid version');
for (const field of ['js', 'css']) {
    const path = resolve(root, manifest[field]);
    if (relative(root, path).startsWith('..')) throw new Error('Unsafe path');
    await access(path);
}
const entry = await readFile(resolve(root, manifest.js), 'utf8');
for (const hook of Object.values(manifest.hooks)) {
    if (!new RegExp(`export function ${hook}\\(`).test(entry)) throw new Error(`Missing hook ${hook}`);
}
for (const file of await readdir(root)) if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', resolve(root, file)]);
const contract = JSON.parse(await readFile(resolve(root, 'capability-contract.json'), 'utf8'));
if (contract.requirements.some(r => !r.id || !r.symbol || !r.owner)) throw new Error('Invalid capability contract');
console.log('Manifest paths, lifecycle exports, JavaScript syntax and capability contract: PASS');
