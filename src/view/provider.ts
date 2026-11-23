import crypto from 'node:crypto';
import * as vscode from 'vscode';
import { DeviceManager } from '../devices/deviceManager';
import { log } from '../log';
import { ExtToWebview, WebviewToExt } from '../shared/protocol';
import { StreamBridge } from '../stream/bridge';

export class SidemuViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'sidemu.screenView';

  private view: vscode.WebviewView | undefined;
  private ready = false;
  private queue: ExtToWebview[] = [];
  private attachedId: string | null = null;
  private mcpUrl: string | null = null;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly dm: DeviceManager,
    private readonly bridge: StreamBridge,
  ) {}

  setMcpUrl(url: string | null): void {
    this.mcpUrl = url;
    this.pushState();
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${SidemuViewProvider.viewType}.focus`);
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    this.ready = false;

    const bridgePort = await this.bridge.start();
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.ctx.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.ctx.extensionUri, 'media'),
      ],
      portMapping: [{ webviewPort: bridgePort, extensionHostPort: bridgePort }],
    };

    webview.html = this.buildHtml(webview, bridgePort);

    webview.onDidReceiveMessage((msg: WebviewToExt) => {
      void this.handleMessage(msg);
    });

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
        this.ready = false;
      }
    });
  }

  private buildHtml(webview: vscode.Webview, bridgePort: number): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'main.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'));

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `connect-src http://127.0.0.1:${bridgePort}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${cssUri.toString()}" />
  <title>Sidemu</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${jsUri.toString()}"></script>
</body>
</html>`;
  }

  private post(msg: ExtToWebview): void {
    if (!this.view || !this.ready) {
      if (msg.type === 'state') {
        this.queue = this.queue.filter((m) => m.type !== 'state');
      }
      this.queue.push(msg);
      if (this.queue.length > 50) {
        this.queue.shift();
      }
      return;
    }
    void this.view.webview.postMessage(msg);
  }

  pushState(): void {
    this.post({
      type: 'state',
      devices: this.dm.devices,
      launchTargets: this.dm.launchTargets,
      activeId: this.dm.activeId,
      toolchain: this.dm.toolchain,
      mcpUrl: this.mcpUrl,
      busy: this.dm.busy,
    });
  }

  attach(deviceId: string): void {
    const dev = this.dm.devices.find((d) => d.id === deviceId && d.state === 'online');
    if (!dev) {
      return;
    }
    this.attachedId = dev.id;
    this.post({
      type: 'attach',
      deviceId: dev.id,
      platform: dev.platform,
      streamUrl: this.bridge.url(dev.id),
    });
  }

  detach(reason: string): void {
    this.attachedId = null;
    this.post({ type: 'detach', reason });
  }

  overlay(msg: Extract<ExtToWebview, { type: 'overlay' }>): void {
    this.post(msg);
  }

  status(level: 'info' | 'progress' | 'error', text: string): void {
    this.post({ type: 'status', level, text });
  }

  private async handleMessage(msg: WebviewToExt): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready': {
          this.ready = true;
          const pending = this.queue;
          this.queue = [];
          this.pushState();
          for (const item of pending) {
            if (item.type !== 'state') {
              void this.view?.webview.postMessage(item);
            }
          }
          if (this.dm.activeId) {
            const dev = this.dm.devices.find(
              (d) => d.id === this.dm.activeId && d.state === 'online',
            );
            if (dev) {
              this.attach(dev.id);
            }
          }
          return;
        }
        case 'selectDevice': {
          this.dm.selectDevice(msg.id);
          if (msg.id.startsWith('launch:')) {
            this.detach('Select Boot to launch this emulator target.');
            return;
          }
          const dev = this.dm.devices.find((d) => d.id === msg.id);
          if (dev && dev.state === 'online') {
            this.attach(dev.id);
          } else {
            this.detach(dev ? 'Device is offline. Click Boot to start it.' : 'No device selected.');
          }
          return;
        }
        case 'boot': {
          const bootedId = await this.dm.boot(msg.id, () => this.focus());
          this.attach(bootedId);
          return;
        }
        case 'shutdown': {
          this.detach('Shutting down device…');
          await this.dm.shutdown(msg.id);
          return;
        }
        case 'refresh': {
          await this.dm.refresh({ resolveEnvironment: true });
          return;
        }
        case 'frameSize': {
          this.dm.setLastFrameSize(msg.width, msg.height);
          return;
        }
        case 'tap': {
          const id = this.dm.resolveTargetDeviceId(this.attachedId ?? undefined);
          const pt = await this.dm.toDevicePoint(id, msg.x, msg.y, msg.frameW, msg.frameH);
          await this.dm.tap(id, pt.x, pt.y, 'user');
          return;
        }
        case 'longpress': {
          const id = this.dm.resolveTargetDeviceId(this.attachedId ?? undefined);
          const pt = await this.dm.toDevicePoint(id, msg.x, msg.y, msg.frameW, msg.frameH);
          await this.dm.longpress(id, pt.x, pt.y, msg.durationMs, 'user');
          return;
        }
        case 'swipe': {
          const id = this.dm.resolveTargetDeviceId(this.attachedId ?? undefined);
          const p1 = await this.dm.toDevicePoint(id, msg.x1, msg.y1, msg.frameW, msg.frameH);
          const p2 = await this.dm.toDevicePoint(id, msg.x2, msg.y2, msg.frameW, msg.frameH);
          await this.dm.swipe(id, p1.x, p1.y, p2.x, p2.y, msg.durationMs, 'user');
          return;
        }
        case 'text': {
          const id = this.dm.resolveTargetDeviceId(this.attachedId ?? undefined);
          await this.dm.typeText(id, msg.text);
          return;
        }
        case 'key': {
          const id = this.dm.resolveTargetDeviceId(this.attachedId ?? undefined);
          await this.dm.pressSpecialKey(id, msg.key);
          return;
        }
        case 'button': {
          const id = this.dm.resolveTargetDeviceId(this.attachedId ?? undefined);
          await this.dm.pressButton(id, msg.button);
          return;
        }
        case 'screenshot': {
          await vscode.commands.executeCommand('sidemu.screenshot');
          return;
        }
        case 'copyMcpConfig': {
          await vscode.commands.executeCommand('sidemu.copyMcpConfig');
          return;
        }
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      log.error(`Webview action failed (${msg.type}): ${text}`);
      this.status('error', text);
    }
  }

  dispose(): void {
    this.view = undefined;
    this.queue = [];
    this.ready = false;
  }
}
