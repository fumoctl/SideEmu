import crypto from 'node:crypto';
import http from 'node:http';
import * as vscode from 'vscode';
import { DeviceManager } from '../devices/deviceManager';
import { log } from '../log';
import { MobileCliServer } from '../mobilecli/server';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Private-Network': 'true',
};

function tokensMatch(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class StreamBridge implements vscode.Disposable {
  private readonly token = crypto.randomBytes(24).toString('hex');
  private server: http.Server | null = null;
  private _port: number | null = null;
  private activeUpstream: http.IncomingMessage | null = null;
  private activeResponses = new Set<http.ServerResponse>();

  constructor(
    private readonly mobilecli: MobileCliServer,
    private readonly dm: DeviceManager,
  ) {}

  get port(): number | null {
    return this._port;
  }

  url(deviceId: string): string {
    if (this._port === null) {
      throw new Error('Stream bridge is not running');
    }
    return `http://127.0.0.1:${this._port}/stream?token=${this.token}&device=${encodeURIComponent(deviceId)}`;
  }

  async start(): Promise<number> {
    if (this.server && this._port !== null) {
      return this._port;
    }

    const srv = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server = srv;

    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to bind stream bridge port'));
          return;
        }
        this._port = addr.port;
        log.info(`Stream bridge listening on 127.0.0.1:${this._port}`);
        resolve();
      });
    });

    return this._port!;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, CORS_HEADERS);
      res.end('Method not allowed');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/stream') {
      res.writeHead(404, CORS_HEADERS);
      res.end('Not found');
      return;
    }

    const reqToken = url.searchParams.get('token') ?? '';
    if (!tokensMatch(this.token, reqToken)) {
      res.writeHead(403, CORS_HEADERS);
      res.end('Forbidden');
      return;
    }

    const deviceId = url.searchParams.get('device') ?? '';
    const device = this.dm.devices.find((d) => d.id === deviceId && d.state === 'online');
    if (!device) {
      res.writeHead(404, CORS_HEADERS);
      res.end('Online device not found');
      return;
    }

    if (this.activeUpstream) {
      this.activeUpstream.destroy();
      this.activeUpstream = null;
    }

    const cfg = vscode.workspace.getConfiguration('sidemu');
    const quality = cfg.get<number>('streamQuality', 70);
    const scale = cfg.get<number>('streamScale', 0.5);

    try {
      const upstream = await this.mobilecli.openStream(deviceId, { quality, scale });
      if (res.destroyed || req.destroyed) {
        upstream.destroy();
        return;
      }

      this.activeUpstream = upstream;
      this.activeResponses.add(res);

      const contentType =
        upstream.headers['content-type'] ?? 'multipart/x-mixed-replace; boundary=BoundaryString';
      res.writeHead(200, {
        ...CORS_HEADERS,
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      });

      upstream.pipe(res);

      const cleanup = () => {
        this.activeResponses.delete(res);
        if (this.activeUpstream === upstream) {
          this.activeUpstream = null;
        }
        upstream.destroy();
      };

      res.on('close', cleanup);
      upstream.on('error', (err) => {
        log.warn(`Upstream stream error for ${deviceId}: ${err.message}`);
        cleanup();
        if (!res.writableEnded) {
          res.end();
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to open stream for ${deviceId}: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(502, CORS_HEADERS);
      }
      if (!res.writableEnded) {
        res.end(msg);
      }
    }
  }

  dispose(): void {
    if (this.activeUpstream) {
      this.activeUpstream.destroy();
      this.activeUpstream = null;
    }
    for (const res of this.activeResponses) {
      res.destroy();
    }
    this.activeResponses.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this._port = null;
  }
}
