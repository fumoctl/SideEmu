import { EventEmitter } from 'node:events';
import * as vscode from 'vscode';
import { MobileCliServer } from '../mobilecli/server';

interface RawIosDevice {
  id: string;
  state: string;
}

export class IosPoller extends EventEmitter implements vscode.Disposable {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private disposed = false;
  private lastOnlineKey = '';

  constructor(private readonly server: MobileCliServer) {
    super();
  }

  start(): void {
    if (this.disposed || process.platform !== 'darwin' || this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.poll();
    }, 2000);
  }

  private async poll(): Promise<void> {
    if (this.disposed || this.inFlight || !this.server.isRunning) {
      return;
    }
    this.inFlight = true;
    try {
      const res = await this.server.rpc<{ devices?: RawIosDevice[] }>(
        'devices.list',
        { platform: 'ios' },
        5000,
      );
      const onlineIds = (res.devices ?? [])
        .filter((d) => d.state === 'online')
        .map((d) => d.id)
        .sort();
      const key = JSON.stringify(onlineIds);
      if (key !== this.lastOnlineKey) {
        this.lastOnlineKey = key;
        this.emit('change');
      }
    } catch {
      // Ignore transient poll errors
    } finally {
      this.inFlight = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.removeAllListeners();
  }
}
