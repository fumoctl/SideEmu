import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUPPORTED_TARGETS,
  fetchMobilecli,
  resolveHostTarget,
} from './fetch-mobilecli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'dist-vsix');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function runVscePackage(target) {
  const vsceBin = path.join(
    ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'vsce.cmd' : 'vsce',
  );
  const outPath = path.join(OUT_DIR, `${pkg.name}-${target}-${pkg.version}.vsix`);

  return new Promise((resolve, reject) => {
    const child = spawn(
      vsceBin,
      ['package', '--no-dependencies', '--target', target, '--out', outPath],
      {
        cwd: ROOT,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      },
    );
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(outPath);
      } else {
        reject(new Error(`vsce package failed for ${target} with exit code ${code ?? 'null'}`));
      }
    });
  });
}

const arg = process.argv[2] ?? 'host';
fs.mkdirSync(OUT_DIR, { recursive: true });

if (arg === 'all') {
  for (const target of SUPPORTED_TARGETS) {
    console.log(`\n[package] Packaging ${target}...`);
    await fetchMobilecli(target);
    await runVscePackage(target);
  }
  console.log('\n[package] Restoring host mobilecli binary...');
  await fetchMobilecli(resolveHostTarget());
} else {
  const target = arg === 'host' ? resolveHostTarget() : arg;
  if (!SUPPORTED_TARGETS.includes(target)) {
    throw new Error(
      `Unknown target "${target}". Use host, all, or one of: ${SUPPORTED_TARGETS.join(', ')}`,
    );
  }
  await fetchMobilecli(target);
  await runVscePackage(target);
}
