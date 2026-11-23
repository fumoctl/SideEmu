import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';

export const MOBILECLI_VERSION = '1.0.23';

export const TARGET_MAP = {
  'linux-x64': {
    asset: `mobilecli-${MOBILECLI_VERSION}-linux-amd64.zip`,
    binName: 'mobilecli',
    sha256: '17c07260f125890106cacb7f839ee1aa4dee17bca410489de9a1d1f6ab120759',
  },
  'linux-arm64': {
    asset: `mobilecli-${MOBILECLI_VERSION}-linux-arm64.zip`,
    binName: 'mobilecli',
    sha256: 'b2c30c187bc708b94891430fed9024150a2a8d9c2f38048d9ce9cc7ef9ebff84',
  },
  'darwin-x64': {
    asset: `mobilecli-${MOBILECLI_VERSION}-macos-amd64.zip`,
    binName: 'mobilecli',
    sha256: '122974d7f96e26d4ac29e1906e898b9f49ffa7272cb8f78887ee4aad6d0626b3',
  },
  'darwin-arm64': {
    asset: `mobilecli-${MOBILECLI_VERSION}-macos-arm64.zip`,
    binName: 'mobilecli',
    sha256: 'e95a227a9fb36586aaec851426d3339bccd14670a7361b351438643bc77d0ae6',
  },
  'win32-x64': {
    asset: `mobilecli-${MOBILECLI_VERSION}-windows-amd64.zip`,
    binName: 'mobilecli.exe',
    sha256: '94cc627be4d2da863b8675a1774d27eaa994fe83edf37b062e66edacf41d1422',
  },
  'win32-arm64': {
    asset: `mobilecli-${MOBILECLI_VERSION}-windows-arm64.zip`,
    binName: 'mobilecli.exe',
    sha256: 'dcf71a9f9545dbd6a0430913312e4845602a0c00f2edbf0eba01a5d4f0fd9829',
  },
};

export const SUPPORTED_TARGETS = Object.keys(TARGET_MAP);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'mobilecli');
const BIN_DIR = path.join(ROOT, 'bin');
const STAMP_PATH = path.join(CACHE_DIR, 'installed.json');

export function resolveHostTarget() {
  const target = `${process.platform}-${process.arch}`;
  if (!(target in TARGET_MAP)) {
    throw new Error(
      `Unsupported host platform "${target}". Supported targets: ${SUPPORTED_TARGETS.join(', ')}`,
    );
  }
  return target;
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

export async function fetchMobilecli(rawTarget = 'host') {
  const target = rawTarget === 'host' ? resolveHostTarget() : rawTarget;
  const spec = TARGET_MAP[target];
  if (!spec) {
    throw new Error(
      `Unknown target "${target}". Supported targets: ${SUPPORTED_TARGETS.join(', ')}`,
    );
  }

  const outBinPath = path.join(BIN_DIR, spec.binName);
  const otherBinName = spec.binName === 'mobilecli' ? 'mobilecli.exe' : 'mobilecli';
  const otherBinPath = path.join(BIN_DIR, otherBinName);

  if (fs.existsSync(STAMP_PATH) && fs.existsSync(outBinPath) && !fs.existsSync(otherBinPath)) {
    try {
      const stamp = JSON.parse(fs.readFileSync(STAMP_PATH, 'utf8'));
      if (stamp.target === target && stamp.sha === spec.sha256) {
        if (!target.startsWith('win32-')) {
          fs.chmodSync(outBinPath, 0o755);
        }
        console.log(`[fetch-mobilecli] mobilecli ${MOBILECLI_VERSION} (${target}) already installed.`);
        return outBinPath;
      }
    } catch {
      // Re-install if stamp is unreadable
    }
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(BIN_DIR, { recursive: true });

  const zipPath = path.join(CACHE_DIR, spec.asset);
  let reuseCached = false;
  if (fs.existsSync(zipPath)) {
    const existingSha = sha256File(zipPath);
    if (existingSha === spec.sha256) {
      reuseCached = true;
      console.log(`[fetch-mobilecli] Reusing cached ${spec.asset} (SHA-256 verified).`);
    } else {
      fs.rmSync(zipPath, { force: true });
    }
  }

  if (!reuseCached) {
    const url = `https://github.com/mobile-next/mobilecli/releases/download/${MOBILECLI_VERSION}/${spec.asset}`;
    console.log(`[fetch-mobilecli] Downloading ${url} ...`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    const actualSha = sha256Buffer(data);
    if (actualSha !== spec.sha256) {
      throw new Error(
        `SHA-256 mismatch for ${spec.asset}: expected ${spec.sha256}, got ${actualSha}`,
      );
    }
    fs.writeFileSync(zipPath, data);
    console.log(`[fetch-mobilecli] Verified SHA-256 (${actualSha}).`);
  }

  fs.rmSync(path.join(BIN_DIR, 'mobilecli'), { force: true });
  fs.rmSync(path.join(BIN_DIR, 'mobilecli.exe'), { force: true });

  const zip = new AdmZip(zipPath);
  const entry = zip.getEntry(spec.binName);
  if (!entry) {
    throw new Error(`Entry "${spec.binName}" not found inside ${spec.asset}`);
  }
  fs.writeFileSync(outBinPath, entry.getData());

  if (!target.startsWith('win32-')) {
    fs.chmodSync(outBinPath, 0o755);
  }

  fs.writeFileSync(
    STAMP_PATH,
    JSON.stringify({ target, sha: spec.sha256, version: MOBILECLI_VERSION }, null, 2) + '\n',
  );
  console.log(`[fetch-mobilecli] Extracted ${spec.binName} for ${target} to bin/.`);
  return outBinPath;
}

function parseArgs(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--target') {
      const val = argv[i + 1];
      if (!val) {
        throw new Error('--target requires a value');
      }
      return val;
    }
    if (argv[i]?.startsWith('--target=')) {
      return argv[i].slice('--target='.length);
    }
  }
  return 'host';
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const target = parseArgs(process.argv.slice(2));
  await fetchMobilecli(target);
}
