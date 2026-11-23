import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { log } from '../log';
import { execFileText, which } from '../proc';

export interface LocalAvd {
  id: string;
  avdId: string;
  name: string;
  version?: string;
  avdHome: string;
  userHome: string;
  avdPath: string;
  sysdir?: string;
}

const EMULATOR_NIX_PACKAGES = [
  'libbsd',
  'libdrm',
  'libuuid',
  'libxkbfile',
  'libpng',
  'vulkan-loader',
  'libGL',
  'libglvnd',
  'mesa',
  'libpulseaudio',
  'alsa-lib',
  'nss',
  'nspr',
  'dbus',
  'zlib',
  'stdenv.cc.cc',
  'libxkbcommon',
  'wayland',
  'libxcb',
  'libx11',
  'libxcursor',
  'libxi',
  'libxrender',
  'libxrandr',
  'libxfixes',
  'libxcomposite',
  'libxdamage',
  'libxext',
  'expat',
  'fontconfig',
  'freetype',
];

const ADB_NIX_PACKAGES = ['stdenv.cc.cc', 'zlib'];

export function expandHome(p: string): string {
  if (p === '~') {
    return os.homedir();
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function uniqueNonEmpty(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const trimmed = raw?.trim();
    if (!trimmed) {
      continue;
    }
    const resolved = path.resolve(expandHome(trimmed));
    if (!seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

export function candidateSdkDirs(env: NodeJS.ProcessEnv): string[] {
  const override = vscode.workspace
    .getConfiguration('sidemu')
    .get<string>('androidHome', '')
    .trim();

  const home = os.homedir();
  const xdgData = env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share');

  const platformDefaults =
    process.platform === 'darwin'
      ? [path.join(home, 'Library', 'Android', 'sdk')]
      : process.platform === 'win32'
        ? [
            env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Android', 'Sdk') : undefined,
            env.USERPROFILE
              ? path.join(env.USERPROFILE, 'AppData', 'Local', 'Android', 'Sdk')
              : undefined,
          ]
        : [
            path.join(xdgData, 'Android', 'Sdk'),
            path.join(xdgData, 'Android'),
            path.join(home, '.local', 'share', 'Android', 'Sdk'),
            path.join(home, '.local', 'share', 'Android'),
            path.join(home, 'Android', 'Sdk'),
            path.join(home, 'Android'),
          ];

  return uniqueNonEmpty([
    override || undefined,
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    ...platformDefaults,
  ]);
}

export function candidateAvdDirs(env: NodeJS.ProcessEnv): string[] {
  const override = vscode.workspace
    .getConfiguration('sidemu')
    .get<string>('avdHome', '')
    .trim();

  const home = os.homedir();
  const xdgConfig = env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config');

  const rawCandidates = uniqueNonEmpty([
    override || undefined,
    env.ANDROID_AVD_HOME,
    env.ANDROID_EMULATOR_HOME ? path.join(env.ANDROID_EMULATOR_HOME, 'avd') : undefined,
    env.ANDROID_USER_HOME ? path.join(env.ANDROID_USER_HOME, 'avd') : undefined,
    path.join(xdgConfig, '.android', 'avd'),
    path.join(xdgConfig, 'android', 'avd'),
    path.join(home, '.config', '.android', 'avd'),
    path.join(home, '.android', 'avd'),
  ]);

  const seenReal = new Set<string>();
  const existing: string[] = [];
  for (const dir of rawCandidates) {
    try {
      if (!fs.statSync(dir).isDirectory()) {
        continue;
      }
      const real = fs.realpathSync(dir);
      if (!seenReal.has(real)) {
        seenReal.add(real);
        existing.push(dir);
      }
    } catch {
      // Directory does not exist
    }
  }
  return existing;
}

function parseIniKV(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key) {
      out[key] = val;
    }
  }
  return out;
}

export async function discoverLocalAvds(env: NodeJS.ProcessEnv): Promise<LocalAvd[]> {
  const avdDirs = candidateAvdDirs(env);
  const seenIds = new Set<string>();
  const avds: LocalAvd[] = [];

  for (const avdHome of avdDirs) {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(avdHome);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.ini')) {
        continue;
      }
      const id = entry.slice(0, -'.ini'.length);
      if (!id || seenIds.has(id)) {
        continue;
      }

      const iniPath = path.join(avdHome, entry);
      let iniKv: Record<string, string>;
      try {
        iniKv = parseIniKV(await fs.promises.readFile(iniPath, 'utf8'));
      } catch {
        continue;
      }

      const userHome = path.dirname(avdHome);
      let avdPath = iniKv.path ? expandHome(iniKv.path) : '';
      if (!avdPath || !fs.existsSync(avdPath)) {
        if (iniKv['path.rel']) {
          const relCandidate = path.resolve(userHome, iniKv['path.rel']);
          if (fs.existsSync(relCandidate)) {
            avdPath = relCandidate;
          }
        }
      }
      if (!avdPath || !fs.existsSync(avdPath)) {
        continue;
      }

      let cfgKv: Record<string, string> = {};
      try {
        cfgKv = parseIniKV(await fs.promises.readFile(path.join(avdPath, 'config.ini'), 'utf8'));
      } catch {
        // config.ini optional fallback
      }

      const avdId = cfgKv.AvdId || id;
      const name = cfgKv['avd.ini.displayname'] || id.replace(/_/g, ' ');
      const targetRaw = cfgKv.target || iniKv.target || '';
      const version = targetRaw.startsWith('android-')
        ? targetRaw.slice('android-'.length)
        : targetRaw || undefined;
      const sysdirRaw = cfgKv['image.sysdir.1']?.replace(/\/+$/, '');

      seenIds.add(id);
      avds.push({
        id,
        avdId,
        name,
        ...(version ? { version } : {}),
        avdHome,
        userHome,
        avdPath,
        ...(sysdirRaw ? { sysdir: sysdirRaw } : {}),
      });
    }
  }

  return avds;
}

export function resolveSdkForAvd(env: NodeJS.ProcessEnv, avd: LocalAvd): string {
  const candidates = candidateSdkDirs(env);
  const emuName = process.platform === 'win32' ? 'emulator.exe' : 'emulator';
  const withEmulator = candidates.filter((sdk) =>
    fs.existsSync(path.join(sdk, 'emulator', emuName)),
  );

  if (avd.sysdir) {
    const sysdirRel = avd.sysdir.split('/').join(path.sep);
    const matching = withEmulator.find((sdk) => fs.existsSync(path.join(sdk, sysdirRel)));
    if (matching) {
      return matching;
    }
  }

  if (withEmulator[0]) {
    return withEmulator[0];
  }

  throw new Error(
    `Android emulator binary (${emuName}) not found for AVD "${avd.id}". Checked SDK directories: ${candidates.join(', ') || '(none)'}`,
  );
}

export function isNixOsUnpatchedBinary(binPath: string): boolean {
  return (
    process.platform === 'linux' &&
    !binPath.startsWith('/nix/store/') &&
    (fs.existsSync('/etc/NIXOS') || Boolean(process.env.NIX_LD))
  );
}

export async function resolveNixAlien(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (process.platform !== 'linux') {
    return null;
  }
  const onPath = await which('nix-alien', env);
  if (onPath) {
    return onPath;
  }
  const fallback = '/run/current-system/sw/bin/nix-alien';
  try {
    await fs.promises.access(fallback, fs.constants.X_OK);
    return fallback;
  } catch {
    return null;
  }
}

export async function spawnLocalAvd(
  avd: LocalAvd,
  env: NodeJS.ProcessEnv,
): Promise<{ child: ChildProcess; outputTail: () => string }> {
  const sdkRoot = resolveSdkForAvd(env, avd);
  const isWin = process.platform === 'win32';
  const adbBin = path.join(sdkRoot, 'platform-tools', isWin ? 'adb.exe' : 'adb');
  const emulatorBin = path.join(sdkRoot, 'emulator', isWin ? 'emulator.exe' : 'emulator');

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
    ANDROID_AVD_HOME: avd.avdHome,
    ANDROID_USER_HOME: avd.userHome,
    SIDEMU_ACTIVE: '1',
    MOBILEMCP_DISABLE_TELEMETRY: '1',
  };
  delete childEnv.QT_PLUGIN_PATH;
  delete childEnv.QML2_IMPORT_PATH;

  if (!isWin && fs.existsSync('/run/current-system/sw/bin')) {
    const currentPath = childEnv.PATH ?? '';
    const entries = currentPath.split(path.delimiter).filter(Boolean);
    if (!entries.includes('/run/current-system/sw/bin')) {
      childEnv.PATH = [...entries, '/run/current-system/sw/bin'].join(path.delimiter);
    }
  }

  const nixAlien = await resolveNixAlien(childEnv);

  if (fs.existsSync(adbBin)) {
    const useAlienForAdb = Boolean(nixAlien && isNixOsUnpatchedBinary(adbBin));
    const adbCmd = useAlienForAdb ? nixAlien! : adbBin;
    const adbArgs = useAlienForAdb
      ? ['-s', '-c', '^[^.]+\\.out$', ...ADB_NIX_PACKAGES.flatMap((p) => ['-p', p]), adbBin, 'start-server']
      : ['start-server'];

    log.info(`Starting ADB server via ${useAlienForAdb ? 'nix-alien' : adbBin}`);
    const adbRes = await execFileText(adbCmd, adbArgs, {
      env: childEnv,
      timeoutMs: 60_000,
    });
    if (adbRes.code !== 0) {
      log.warn(`adb start-server returned ${adbRes.code}: ${adbRes.stderr.trim()}`);
    }
  }

  const emuArgs = ['-avd', avd.id, '-no-window', '-no-audio', '-no-boot-anim', '-gpu', 'auto'];
  const useAlienForEmu = Boolean(nixAlien && isNixOsUnpatchedBinary(emulatorBin));
  const spawnCmd = useAlienForEmu ? nixAlien! : emulatorBin;
  const spawnArgs = useAlienForEmu
    ? [
        '-s',
        '-c',
        '^[^.]+\\.out$',
        ...EMULATOR_NIX_PACKAGES.flatMap((p) => ['-p', p]),
        emulatorBin,
        ...emuArgs,
      ]
    : emuArgs;

  log.info(
    `Launching local AVD "${avd.id}" (${avd.avdHome}) using SDK ${sdkRoot}${useAlienForEmu ? ' via nix-alien' : ''}`,
  );

  const child = spawn(spawnCmd, spawnArgs, {
    env: childEnv,
    detached: !isWin,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let tail = '';
  const appendTail = (chunk: Buffer, isErr: boolean) => {
    const text = chunk.toString('utf8');
    tail = (tail + text).slice(-2048);
    const trimmed = text.trim();
    if (trimmed) {
      if (isErr) {
        log.warn(`[emulator:${avd.id}] ${trimmed}`);
      } else {
        log.info(`[emulator:${avd.id}] ${trimmed}`);
      }
    }
  };

  child.stdout?.on('data', (c: Buffer) => appendTail(c, false));
  child.stderr?.on('data', (c: Buffer) => appendTail(c, true));

  return {
    child,
    outputTail: () => tail.trim(),
  };
}
