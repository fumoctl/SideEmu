import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import http from 'node:http';
import * as vscode from 'vscode';
import { DeviceManager } from '../devices/deviceManager';
import { log } from '../log';
import { McpUiBridge, registerTools } from './tools';

export class McpHost implements vscode.Disposable {
  private server: http.Server | null = null;
  private _port: number | null = null;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly version: string,
    private readonly dm: DeviceManager,
    private readonly ui: McpUiBridge,
  ) {}

  get port(): number | null {
    return this._port;
  }

  get url(): string | null {
    return this._port !== null ? `http://127.0.0.1:${this._port}/mcp` : null;
  }

  async start(): Promise<string> {
    if (this.server && this._port !== null) {
      return this.url!;
    }

    const configuredPort = vscode.workspace
      .getConfiguration('sidemu')
      .get<number>('mcpPort', 45821);

    const bind = (portToTry: number): Promise<number> => {
      return new Promise((resolve, reject) => {
        const srv = http.createServer((req, res) => {
          void this.handleRequest(req, res);
        });
        srv.once('error', (err: NodeJS.ErrnoException) => {
          srv.close();
          reject(err);
        });
        srv.listen(portToTry, '127.0.0.1', () => {
          const addr = srv.address();
          if (!addr || typeof addr === 'string') {
            srv.close(() => reject(new Error('Failed to obtain MCP server port')));
            return;
          }
          this.server = srv;
          this._port = addr.port;
          resolve(addr.port);
        });
      });
    };

    try {
      await bind(configuredPort);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE' && configuredPort !== 0) {
        log.warn(`MCP port ${configuredPort} is occupied; falling back to an ephemeral port.`);
        await bind(0);
      } else {
        throw err;
      }
    }

    log.info(`Embedded MCP server listening on ${this.url}`);
    this._onDidChange.fire();
    return this.url!;
  }

  async restart(): Promise<string> {
    await this.stop();
    return this.start();
  }

  private isValidHost(hostHeader: string | undefined): boolean {
    if (!hostHeader || this._port === null) {
      return false;
    }
    const lower = hostHeader.toLowerCase();
    return lower === `127.0.0.1:${this._port}` || lower === `localhost:${this._port}`;
  }

  private isValidOrigin(originHeader: string | undefined): boolean {
    if (!originHeader) {
      return true;
    }
    return (
      originHeader.startsWith('http://127.0.0.1') ||
      originHeader.startsWith('http://localhost') ||
      originHeader.startsWith('vscode-')
    );
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.isValidHost(req.headers.host) || !this.isValidOrigin(req.headers.origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden host or origin' }));
      return;
    }

    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (reqUrl.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'sidemu', status: 'ok', version: this.version, mcpUrl: this.url }));
      return;
    }

    if (reqUrl.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed' },
          id: null,
        }),
      );
      return;
    }

    const mcpServer = new McpServer(
      {
        name: 'sidemu',
        version: this.version,
      },
      {
        instructions:
          'Sidemu mirrors and controls Android emulators, iOS simulators, and physical mobile devices in the VSCodium/VS Code sidebar. When asked how to create, structure, or troubleshoot a Nix flake.nix for Android emulators or ADB, call get_nix_flake_guide or read resource sidemu://docs/nix-flake.',
      },
    );
    registerTools(mcpServer, this.dm, this.ui);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      log.error(`MCP request failed: ${text}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
            id: null,
          }),
        );
      }
    }
  }

  async stop(): Promise<void> {
    const srv = this.server;
    this.server = null;
    this._port = null;
    if (srv) {
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections?.();
      });
    }
    this._onDidChange.fire();
  }

  dispose(): void {
    void this.stop();
    this._onDidChange.dispose();
  }
}
