import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { workspaceRoot } from '../env';
import { log } from '../log';
import { execFileText, which } from '../proc';
import { LaunchTarget } from '../shared/protocol';

function nixSystem(): string | null {
  if (process.platform === 'win32') {
    return null;
  }
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const os = process.platform === 'darwin' ? 'darwin' : 'linux';
  return `${arch}-${os}`;
}

export async function detectLaunchTargets(env: NodeJS.ProcessEnv): Promise<LaunchTarget[]> {
  if (!vscode.workspace.isTrusted) {
    return [];
  }

  const configured = vscode.workspace
    .getConfiguration('sidemu')
    .get<string>('launchCommand', '')
    .trim();

  if (configured) {
    return [
      {
        id: 'launch:setting',
        label: `Launch: ${configured}`,
        command: configured,
        source: 'setting',
      },
    ];
  }

  const root = workspaceRoot();
  const sys = nixSystem();
  if (!root || !sys || !fs.existsSync(path.join(root, 'flake.nix'))) {
    return [];
  }

  const nixBin = await which('nix', env);
  if (!nixBin) {
    return [];
  }

  const res = await execFileText(
    nixBin,
    ['--extra-experimental-features', 'nix-command flakes', 'flake', 'show', '--json'],
    {
      cwd: root,
      env,
      timeoutMs: 120_000,
    },
  );

  if (res.code !== 0) {
    log.warn(`nix flake show --json failed (code ${res.code}): ${res.stderr.trim()}`);
    return [];
  }

  try {
    const parsed = JSON.parse(res.stdout) as {
      apps?: Record<string, Record<string, unknown>>;
    };
    if (parsed.apps?.[sys]?.['android-emulator']) {
      return [
        {
          id: 'launch:flake',
          label: 'Nix flake: .#android-emulator',
          command: 'nix run .#android-emulator',
          source: 'flake',
        },
      ];
    }
  } catch (err) {
    log.warn(`Failed to parse nix flake show JSON: ${String(err)}`);
  }

  return [];
}

export function spawnLaunch(
  target: LaunchTarget,
  env: NodeJS.ProcessEnv,
  shimDir: string,
): { child: ChildProcess; outputTail: () => string } {
  const isWin = process.platform === 'win32';
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    SIDEMU_ACTIVE: '1',
    MOBILEMCP_DISABLE_TELEMETRY: '1',
  };
  if (!isWin) {
    const existing = childEnv.PATH ?? '';
    childEnv.PATH = existing ? `${shimDir}${path.delimiter}${existing}` : shimDir;
  }

  log.info(`Spawning launch target (${target.id}): ${target.command}`);
  const child = spawn(target.command, {
    shell: true,
    cwd: workspaceRoot(),
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
        log.warn(`[launch] ${trimmed}`);
      } else {
        log.info(`[launch] ${trimmed}`);
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

export function killLaunchProcess(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) {
    return;
  }
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch {
      // Fallback to direct child kill
    }
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // Ignore
  }
}
