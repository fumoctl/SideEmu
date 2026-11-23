import { EventEmitter } from 'node:events';
import net from 'node:net';
import * as vscode from 'vscode';

function encodeAdbPacket(cmd: string): Buffer {
  const payload = Buffer.from(cmd, 'utf8');
  const lenHex = payload.length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(lenHex, 'ascii'), payload]);
}

function parseTrackDevicesPayload(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split('\t');
    const serial = parts[0]?.trim();
    const state = parts[1]?.trim();
    if (serial && state) {
      result.set(serial, state);
    }
  }
  return result;
}

export class AdbTracker extends EventEmitter implements vscode.Disposable {
  private socket: net.Socket | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private _connected = false;
  private latestDevices = new Map<string, string>();

  get connected(): boolean {
    return this._connected;
  }

  start(): void {
    if (this.disposed || this.socket || this.retryTimer) {
      return;
    }
    this.connect();
  }

  getDevices(): Map<string, string> {
    return new Map(this.latestDevices);
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.disposed) {
        this.connect();
      }
    }, 2000);
  }

  private connect(): void {
    if (this.disposed) {
      return;
    }

    const sock = net.connect(5037, '127.0.0.1');
    this.socket = sock;
    let buf: Buffer = Buffer.alloc(0);
    let phase: 'status' | 'length' | 'payload' = 'status';
    let expectedLen = 0;

    sock.on('connect', () => {
      if (this.disposed || this.socket !== sock) {
        sock.destroy();
        return;
      }
      sock.write(encodeAdbPacket('host:track-devices'));
    });

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        if (phase === 'status') {
          if (buf.length < 4) {
            return;
          }
          const status = buf.subarray(0, 4).toString('ascii');
          buf = buf.subarray(4);
          if (status !== 'OKAY') {
            sock.destroy();
            return;
          }
          this._connected = true;
          phase = 'length';
        } else if (phase === 'length') {
          if (buf.length < 4) {
            return;
          }
          const lenHex = buf.subarray(0, 4).toString('ascii');
          const len = Number.parseInt(lenHex, 16);
          if (Number.isNaN(len) || len < 0) {
            sock.destroy();
            return;
          }
          buf = buf.subarray(4);
          expectedLen = len;
          if (expectedLen === 0) {
            this.latestDevices = new Map();
            this.emit('change', this.getDevices());
          } else {
            phase = 'payload';
          }
        } else {
          if (buf.length < expectedLen) {
            return;
          }
          const payload = buf.subarray(0, expectedLen).toString('utf8');
          buf = buf.subarray(expectedLen);
          phase = 'length';
          this.latestDevices = parseTrackDevicesPayload(payload);
          this.emit('change', this.getDevices());
        }
      }
    });

    const cleanup = () => {
      if (this.socket === sock) {
        this.socket = null;
        this._connected = false;
      }
      this.scheduleRetry();
    };

    sock.on('error', () => {
      // Adb server may not be running yet; retry silently
      cleanup();
    });

    sock.on('close', cleanup);
  }

  dispose(): void {
    this.disposed = true;
    this._connected = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.removeAllListeners();
  }
}

export function adbShell(serial: string, command: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(5037, '127.0.0.1');
    let settled = false;
    let buf: Buffer = Buffer.alloc(0);
    let step: 'transportStatus' | 'transportFailLen' | 'transportFailMsg' | 'shellStatus' | 'shellFailLen' | 'shellFailMsg' | 'stream' =
      'transportStatus';
    let failLen = 0;
    const chunks: Buffer[] = [];

    const finishError = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    };

    const finishSuccess = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    const timer = setTimeout(() => {
      finishError(new Error(`ADB shell timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    sock.on('connect', () => {
      sock.write(encodeAdbPacket(`host:transport:${serial}`));
    });

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        if (step === 'transportStatus' || step === 'shellStatus') {
          if (buf.length < 4) {
            return;
          }
          const status = buf.subarray(0, 4).toString('ascii');
          buf = buf.subarray(4);
          if (status === 'OKAY') {
            if (step === 'transportStatus') {
              step = 'shellStatus';
              sock.write(encodeAdbPacket(`shell:${command}`));
            } else {
              step = 'stream';
              if (buf.length > 0) {
                chunks.push(buf);
                buf = Buffer.alloc(0);
              }
              return;
            }
          } else if (status === 'FAIL') {
            step = step === 'transportStatus' ? 'transportFailLen' : 'shellFailLen';
          } else {
            finishError(new Error(`Unexpected ADB status "${status}"`));
            return;
          }
        } else if (step === 'transportFailLen' || step === 'shellFailLen') {
          if (buf.length < 4) {
            return;
          }
          failLen = Number.parseInt(buf.subarray(0, 4).toString('ascii'), 16);
          buf = buf.subarray(4);
          if (Number.isNaN(failLen) || failLen <= 0) {
            finishError(new Error('ADB request failed'));
            return;
          }
          step = step === 'transportFailLen' ? 'transportFailMsg' : 'shellFailMsg';
        } else if (step === 'transportFailMsg' || step === 'shellFailMsg') {
          if (buf.length < failLen) {
            return;
          }
          const msg = buf.subarray(0, failLen).toString('utf8');
          finishError(new Error(`ADB error: ${msg}`));
          return;
        } else {
          if (buf.length > 0) {
            chunks.push(buf);
            buf = Buffer.alloc(0);
          }
          return;
        }
      }
    });

    sock.on('end', () => {
      if (step === 'stream') {
        finishSuccess();
      } else {
        finishError(new Error('ADB connection closed unexpectedly'));
      }
    });

    sock.on('error', (err) => {
      finishError(err);
    });
  });
}
