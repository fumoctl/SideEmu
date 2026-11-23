import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { candidateAvdDirs, candidateSdkDirs, expandHome } from './devices/avd';
import { log } from './log';
import { execFileText, which } from './proc';

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

interface CachedNixDevEnv {
  nixPath: string | null;
  vars: Record<string, string>;
}

const nixDevEnvCache = new Map<string, CachedNixDevEnv>();

const SKIP_NIX_VARS = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TEMPDIR',
  'NIX_BUILD_TOP',
  'PWD',
  'OLDPWD',
  'SHLVL',
]);

function prependPathEntries(basePath: string | undefined, extraPath: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [extraPath, basePath ?? '']) {
    for (const entry of part.split(path.delimiter)) {
      if (entry && !seen.has(entry)) {
        seen.add(entry);
        out.push(entry);
      }
    }
  }
  return out.join(path.delimiter);
}

async function resolveNixBinary(env: NodeJS.ProcessEnv): Promise<string | null> {
  const onPath = await which('nix', env);
  if (onPath) {
    return onPath;
  }
  for (const candidate of [
    '/run/current-system/sw/bin/nix',
    '/nix/var/nix/profiles/default/bin/nix',
  ]) {
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not available
    }
  }
  return null;
}

function applyCachedNixDevEnv(cached: CachedNixDevEnv, env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(cached.vars)) {
    env[key] = value;
  }
  if (cached.nixPath) {
    env.PATH = prependPathEntries(env.PATH, cached.nixPath);
  }
}

async function applyNixPrintDevEnv(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  const flakePath = path.join(root, 'flake.nix');
  let flakeMtime = 0;
  try {
    flakeMtime = fs.statSync(flakePath).mtimeMs;
  } catch {
    return;
  }
  let lockMtime = 0;
  try {
    lockMtime = fs.statSync(path.join(root, 'flake.lock')).mtimeMs;
  } catch {
    // flake.lock may not exist yet
  }

  const cacheKey = `${root}:${flakeMtime}:${lockMtime}`;
  const cached = nixDevEnvCache.get(cacheKey);
  if (cached) {
    applyCachedNixDevEnv(cached, env);
    return;
  }

  const nixBin = await resolveNixBinary(env);
  if (!nixBin) {
    return;
  }

  const res = await execFileText(
    nixBin,
    ['--extra-experimental-features', 'nix-command flakes', 'print-dev-env', '--json'],
    {
      cwd: root,
      env,
      timeoutMs: 180_000,
    },
  );

  if (res.code !== 0) {
    log.warn(`nix print-dev-env --json failed (code ${res.code}): ${res.stderr.trim()}`);
    return;
  }

  const raw = res.stdout.trim();
  if (!raw) {
    return;
  }

  try {
    const parsed = JSON.parse(raw) as {
      variables?: Record<string, { type?: string; value?: unknown }>;
    };
    const variables = parsed.variables ?? {};
    const vars: Record<string, string> = {};
    let nixPath: string | null = null;

    for (const [key, entry] of Object.entries(variables)) {
      if (entry?.type !== 'exported' || typeof entry.value !== 'string') {
        continue;
      }
      if (key === 'PATH') {
        nixPath = entry.value;
        continue;
      }
      if (SKIP_NIX_VARS.has(key)) {
        continue;
      }
      vars[key] = entry.value;
    }

    if (!vars.ANDROID_HOME && !vars.ANDROID_SDK_ROOT) {
      const hookVal = variables.shellHook?.value;
      if (typeof hookVal === 'string') {
        const match = hookVal.match(
          /(?:export\s+)?ANDROID_(?:HOME|SDK_ROOT)=["']?(\/nix\/store\/[^"'\s;]+)/,
        );
        if (match?.[1] && fs.existsSync(match[1])) {
          vars.ANDROID_HOME = match[1];
        }
      }
    }

    const computed: CachedNixDevEnv = { nixPath, vars };
    if (nixDevEnvCache.size >= 16) {
      const oldestKey = nixDevEnvCache.keys().next().value;
      if (oldestKey !== undefined) {
        nixDevEnvCache.delete(oldestKey);
      }
    }
    nixDevEnvCache.set(cacheKey, computed);
    applyCachedNixDevEnv(computed, env);
  } catch (err) {
    log.warn(`Failed to parse nix print-dev-env JSON output: ${String(err)}`);
  }
}

export async function resolveEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const useDirenv = vscode.workspace.getConfiguration('sidemu').get<boolean>('useDirenv', true);
  const root = workspaceRoot();

  if (useDirenv && vscode.workspace.isTrusted && root) {
    const hasEnvrc = fs.existsSync(path.join(root, '.envrc'));
    const direnvBin = hasEnvrc ? await which('direnv', env) : null;
    if (hasEnvrc && direnvBin) {
      const res = await execFileText(direnvBin, ['export', 'json'], {
        cwd: root,
        env,
        timeoutMs: 120_000,
      });
      if (res.code === 0) {
        const raw = res.stdout.trim();
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            for (const [key, value] of Object.entries(parsed)) {
              if (value === null) {
                delete env[key];
              } else if (typeof value === 'string') {
                env[key] = value;
              }
            }
          } catch (err) {
            log.warn(`Failed to parse direnv JSON output: ${String(err)}`);
          }
        }
      } else {
        log.warn(`direnv export json failed (code ${res.code}): ${res.stderr.trim()}`);
      }
    } else if (fs.existsSync(path.join(root, 'flake.nix'))) {
      await applyNixPrintDevEnv(root, env);
    }
  }

  const cfg = vscode.workspace.getConfiguration('sidemu');
  const androidHomeOverride = cfg.get<string>('androidHome', '').trim();
  const avdHomeOverride = cfg.get<string>('avdHome', '').trim();

  if (androidHomeOverride) {
    const resolved = path.resolve(expandHome(androidHomeOverride));
    if (fs.existsSync(resolved)) {
      env.ANDROID_HOME = resolved;
    }
  }

  if (!env.ANDROID_HOME) {
    if (env.ANDROID_SDK_ROOT && fs.existsSync(env.ANDROID_SDK_ROOT)) {
      env.ANDROID_HOME = env.ANDROID_SDK_ROOT;
    } else {
      const adbBin = await which('adb', env);
      if (adbBin) {
        try {
          const realAdb = fs.realpathSync(adbBin);
          const candidateSdk = path.dirname(path.dirname(realAdb));
          if (fs.existsSync(path.join(candidateSdk, 'platform-tools'))) {
            env.ANDROID_HOME = candidateSdk;
          }
        } catch {
          // Ignore symlink resolution errors
        }
      }
      if (!env.ANDROID_HOME) {
        const sdkWithPlatformTools = candidateSdkDirs(env).find((dir) =>
          fs.existsSync(path.join(dir, 'platform-tools')),
        );
        if (sdkWithPlatformTools) {
          env.ANDROID_HOME = sdkWithPlatformTools;
        }
      }
    }
  }

  if (env.ANDROID_HOME && !env.ANDROID_SDK_ROOT) {
    env.ANDROID_SDK_ROOT = env.ANDROID_HOME;
  }

  if (avdHomeOverride) {
    const resolvedAvd = path.resolve(expandHome(avdHomeOverride));
    if (fs.existsSync(resolvedAvd)) {
      env.ANDROID_AVD_HOME = resolvedAvd;
      if (!env.ANDROID_USER_HOME) {
        env.ANDROID_USER_HOME = path.dirname(resolvedAvd);
      }
    }
  } else if (!env.ANDROID_AVD_HOME) {
    const avdDirs = candidateAvdDirs(env);
    const withIni = avdDirs.find((dir) => {
      try {
        return fs.readdirSync(dir).some((f) => f.endsWith('.ini'));
      } catch {
        return false;
      }
    });
    const chosen = withIni ?? avdDirs[0];
    if (chosen) {
      env.ANDROID_AVD_HOME = chosen;
      if (!env.ANDROID_USER_HOME) {
        env.ANDROID_USER_HOME = path.dirname(chosen);
      }
    }
  }

  env.MOBILEMCP_DISABLE_TELEMETRY = '1';
  return env;
}

export function envFingerprint(env: NodeJS.ProcessEnv): string {
  return JSON.stringify([
    env.PATH ?? env.Path ?? '',
    env.ANDROID_HOME ?? '',
    env.ANDROID_SDK_ROOT ?? '',
    env.ANDROID_AVD_HOME ?? '',
    env.ANDROID_USER_HOME ?? '',
    env.DEVELOPER_DIR ?? '',
  ]);
}

export async function detectToolchain(
  env: NodeJS.ProcessEnv,
): Promise<{ adb: boolean; xcrun: boolean }> {
  const adbName = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const adbInHome = Boolean(
    env.ANDROID_HOME && fs.existsSync(path.join(env.ANDROID_HOME, 'platform-tools', adbName)),
  );
  const adb = adbInHome || Boolean(await which('adb', env));
  const xcrun = process.platform === 'darwin' ? Boolean(await which('xcrun', env)) : false;
  return { adb, xcrun };
}
