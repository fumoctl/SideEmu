import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { envFingerprint, resolveEnv } from '../env';
import { log } from '../log';
import { execFileText, freePort } from '../proc';
import { ensureExecutable, resolveMobilecliPath } from './binary';

interface JsonRpcError {
  code: number;
  message: string;
  data?: string;
}

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number | string | null;
  result?: T;
  error?: JsonRpcError;
}

export class MobileCliServer implements vscode.Disposable {
  private child: ChildProcess | null = null;
  private dead = true;
  private port: number | null = null;
  private fingerprint: string | null = null;
  private lastEnv: NodeJS.ProcessEnv | null = null;
  private lastBin: string | null = null;
  private ensureInFlight: Promise<void> | null = null;
  private nextId = 0;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  get mobilecliHome(): string {
    if (process.platform === 'win32') {
      return path.join(os.tmpdir(), `sidemu-${process.pid}`);
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    return path.join('/tmp', `sidemu-${uid}-${process.pid}`);
  }

  get shimDir(): string {
    return path.join(this.ctx.extensionPath, 'shim');
  }

  get isRunning(): boolean {
    return Boolean(this.child && !this.dead && this.port !== null);
  }

  get baseUrl(): string {
    if (this.port === null) {
      throw new Error('mobilecli server is not running');
    }
    return `http://127.0.0.1:${this.port}`;
  }

  childEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      MOBILECLI_HOME: this.mobilecliHome,
      MOBILEMCP_DISABLE_TELEMETRY: '1',
      SIDEMU_ACTIVE: '1',
    };
    if (process.platform !== 'win32') {
      const existingPath = env.PATH ?? '';
      env.PATH = existingPath ? `${this.shimDir}${path.delimiter}${existingPath}` : this.shimDir;
    }
    return env;
  }

  async ensure(env: NodeJS.ProcessEnv): Promise<void> {
    if (this.ensureInFlight) {
      await this.ensureInFlight;
      if (this.isRunning && this.fingerprint === envFingerprint(env)) {
        return;
      }
    }

    const promise = this._ensure(env);
    this.ensureInFlight = promise;
    try {
      await promise;
    } finally {
      if (this.ensureInFlight === promise) {
        this.ensureInFlight = null;
      }
    }
  }

  private async _ensure(env: NodeJS.ProcessEnv): Promise<void> {
    const fp = envFingerprint(env);
    if (this.isRunning && this.fingerprint === fp) {
      return;
    }

    if (this.child || this.fingerprint !== null) {
      await this.stop({ stopDaemon: true });
    }

    const bin = resolveMobilecliPath(this.ctx);
    ensureExecutable(bin);
    fs.mkdirSync(this.mobilecliHome, { recursive: true, mode: 0o700 });

    const port = await freePort();
    const spawnEnv = this.childEnv(env);
    this.lastEnv = env;
    this.lastBin = bin;
    this.fingerprint = fp;
    this.port = port;
    this.dead = false;

    log.info(`Starting mobilecli server on 127.0.0.1:${port}`);
    const child = spawn(bin, ['server', 'start', '--listen', `127.0.0.1:${port}`], {
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    let earlyExit: string | null = null;
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        log.debug(`[mobilecli] ${text}`);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        log.warn(`[mobilecli] ${text}`);
      }
    });
    child.on('error', (err) => {
      earlyExit = err.message;
      if (this.child === child) {
        this.dead = true;
        this.child = null;
      }
      log.error(`mobilecli process error: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      earlyExit = `code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      if (this.child === child) {
        this.dead = true;
        this.child = null;
      }
      log.info(`mobilecli server exited (${earlyExit})`);
    });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (earlyExit !== null || this.child !== child) {
        this.dead = true;
        this.port = null;
        throw new Error(`mobilecli server exited prematurely (${earlyExit ?? 'unknown'})`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(500),
        });
        if (res.ok) {
          return;
        }
      } catch {
        // Still starting up
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    await this.stop({ stopDaemon: false });
    throw new Error('Timed out waiting for mobilecli server to listen');
  }

  async rpc<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.isRunning) {
      const env = this.lastEnv ?? (await resolveEnv());
      await this.ensure(env);
    }

    const effectiveTimeout =
      timeoutMs ??
      (method === 'device.boot' ||
      method === 'device.apps.install' ||
      method === 'device.apps.uninstall'
        ? 200_000
        : method === 'device.dump.ui' ||
            method === 'device.screenrecord' ||
            method === 'device.screenrecord.stop'
          ? 70_000
          : method === 'device.shutdown'
            ? 60_000
            : 30_000);

    const id = ++this.nextId;
    const response = await fetch(`${this.baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      }),
      signal: AbortSignal.timeout(effectiveTimeout),
    });

    if (!response.ok) {
      throw new Error(`mobilecli HTTP ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as JsonRpcResponse<T>;
    if (payload.error) {
      throw new Error(payload.error.data ?? payload.error.message ?? `RPC error ${payload.error.code}`);
    }
    return payload.result as T;
  }

  async openStream(
    deviceId: string,
    opts: { quality: number; scale: number },
  ): Promise<http.IncomingMessage> {
    const result = await this.rpc<{ format: string; sessionUrl: string }>('device.screencapture', {
      deviceId,
      format: 'mjpeg',
      quality: opts.quality,
      scale: opts.scale,
    });

    const streamUrl = new URL(result.sessionUrl, this.baseUrl).toString();
    return new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.get(streamUrl, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          reject(new Error(`mobilecli stream returned HTTP ${res.statusCode}`));
          return;
        }
        resolve(res);
      });
      req.on('error', reject);
    });
  }

  async stop({ stopDaemon }: { stopDaemon: boolean }): Promise<void> {
    const child = this.child;
    const port = this.port;
    this.child = null;
    this.dead = true;
    this.port = null;

    if (port !== null && child) {
      try {
        await fetch(`http://127.0.0.1:${port}/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: ++this.nextId,
            method: 'server.shutdown',
          }),
          signal: AbortSignal.timeout(1500),
        });
      } catch {
        // Best effort shutdown RPC
      }
    }

    if (child && child.exitCode === null && !child.killed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGTERM');
          } catch {
            // Ignore
          }
          setTimeout(resolve, 400);
        }, 1000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    if (stopDaemon) {
      try {
        const bin = this.lastBin ?? resolveMobilecliPath(this.ctx);
        const env = this.childEnv(this.lastEnv ?? process.env);
        await execFileText(bin, ['daemon', 'stop'], { env, timeoutMs: 5000 });
      } catch {
        // Best effort daemon stop
      }
      try {
        fs.rmSync(this.mobilecliHome, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  dispose(): void {
    void this.stop({ stopDaemon: false });
  }
}
