import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export interface ExecFileOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface ExecFileResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function execFileText(
  cmd: string,
  args: string[],
  opts: ExecFileOptions = {},
): Promise<ExecFileResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }
        const errWithCode = err as NodeJS.ErrnoException & { status?: number | null };
        const numericCode =
          typeof errWithCode.code === 'number'
            ? errWithCode.code
            : typeof errWithCode.status === 'number'
              ? errWithCode.status
              : -1;
        resolve({
          stdout: stdout ?? '',
          stderr: stderr || err.message,
          code: numericCode,
        });
      },
    );
  });
}

export async function which(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const pathEnv = env.PATH ?? env.Path ?? '';
  if (!pathEnv) {
    return null;
  }

  const isWin = process.platform === 'win32';
  const exts = isWin
    ? path.extname(cmd)
      ? ['']
      : (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];

  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${cmd}${ext}`);
      try {
        const st = await fs.promises.stat(candidate);
        if (!st.isFile()) {
          continue;
        }
        await fs.promises.access(candidate, isWin ? fs.constants.F_OK : fs.constants.X_OK);
        return candidate;
      } catch {
        // Not executable or does not exist
      }
    }
  }
  return null;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Failed to obtain ephemeral port')));
        return;
      }
      const { port } = addr;
      srv.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
        } else {
          resolve(port);
        }
      });
    });
  });
}
