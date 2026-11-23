import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { AdbTracker } from './devices/adb';
import { DeviceManager } from './devices/deviceManager';
import { IosPoller } from './devices/iosPoller';
import { log } from './log';
import { McpHost } from './mcp/host';
import { copyMcpConfigCommand, registerMcpProvider } from './mcp/register';
import { ensureExecutable, resolveMobilecliPath } from './mobilecli/binary';
import { MobileCliServer } from './mobilecli/server';
import { StreamBridge } from './stream/bridge';
import { SidemuViewProvider } from './view/provider';

interface SidemuServices {
  mcpHost: McpHost;
  bridge: StreamBridge;
  tracker: AdbTracker;
  poller: IosPoller;
  dm: DeviceManager;
  server: MobileCliServer;
}

let activeServices: SidemuServices | null = null;

export function activate(ctx: vscode.ExtensionContext): void {
  const version = String(
    (ctx.extension.packageJSON as { version?: unknown } | undefined)?.version ?? '0.1.0',
  );

  const shimDir = path.join(ctx.extensionPath, 'shim');
  ensureExecutable(path.join(shimDir, 'emulator'));
  try {
    ensureExecutable(resolveMobilecliPath(ctx));
  } catch {
    // Missing binary error will be surfaced cleanly in toolchain status and UI
  }

  ctx.environmentVariableCollection.description =
    'Sidemu headless emulator integration (SIDEMU_ACTIVE=1 and emulator PATH shim)';
  ctx.environmentVariableCollection.replace('SIDEMU_ACTIVE', '1');
  ctx.environmentVariableCollection.replace('VSCODIUM_ANDROID_SIDEBAR', '1');
  if (process.platform !== 'win32') {
    ctx.environmentVariableCollection.prepend('PATH', `${shimDir}${path.delimiter}`);
  }

  const server = new MobileCliServer(ctx);
  const tracker = new AdbTracker();
  const poller = new IosPoller(server);
  const dm = new DeviceManager(server, tracker, poller);
  const bridge = new StreamBridge(server, dm);
  const provider = new SidemuViewProvider(ctx, dm, bridge);
  const mcpHost = new McpHost(version, dm, {
    focus: () => provider.focus(),
  });

  activeServices = { mcpHost, bridge, tracker, poller, dm, server };

  ctx.subscriptions.push(
    log,
    provider,
    mcpHost,
    bridge,
    tracker,
    poller,
    dm,
    server,
    vscode.window.registerWebviewViewProvider(SidemuViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    registerMcpProvider(mcpHost, version),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('sidemu.copyMcpConfig', async () => {
      await copyMcpConfigCommand(mcpHost);
    }),
    vscode.commands.registerCommand('sidemu.refreshDevices', async () => {
      await dm.refresh({ resolveEnvironment: true });
    }),
    vscode.commands.registerCommand('sidemu.bootDevice', async () => {
      if (dm.devices.length === 0 && dm.launchTargets.length === 0) {
        await dm.refresh({ resolveEnvironment: true });
      }
      const items: Array<{ label: string; description: string; id: string }> = [
        ...dm.launchTargets.map((t) => ({
          label: t.label,
          description: t.command,
          id: t.id,
        })),
        ...dm.devices
          .filter((d) => d.state === 'offline' && d.type !== 'real')
          .map((d) => ({
            label: d.name,
            description: `${d.platform} ${d.type} (${d.id})`,
            id: d.id,
          })),
      ];
      if (items.length === 0) {
        void vscode.window.showInformationMessage(
          'No offline emulators, simulators, or Nix launch targets found.',
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select an emulator, simulator, or Nix target to boot headlessly',
      });
      if (!picked) {
        return;
      }
      try {
        const bootedId = await dm.boot(picked.id, () => provider.focus());
        provider.attach(bootedId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Sidemu boot failed: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('sidemu.shutdownDevice', async () => {
      const online = dm.devices.filter((d) => d.state === 'online' && d.type !== 'real');
      let targetId =
        dm.activeId && online.some((d) => d.id === dm.activeId) ? dm.activeId : undefined;
      if (!targetId && online.length === 1) {
        targetId = online[0]!.id;
      } else if (!targetId && online.length > 1) {
        const picked = await vscode.window.showQuickPick(
          online.map((d) => ({ label: d.name, description: d.id, id: d.id })),
          { placeHolder: 'Select an online emulator or simulator to shut down' },
        );
        targetId = picked?.id;
      }
      if (!targetId) {
        void vscode.window.showInformationMessage('No running emulator or simulator to shut down.');
        return;
      }
      provider.detach('Shutting down device…');
      await dm.shutdown(targetId);
    }),
    vscode.commands.registerCommand('sidemu.screenshot', async () => {
      try {
        const id = dm.resolveTargetDeviceId();
        const shot = await dm.screenshot(id, { format: 'png' });
        const defaultDir =
          vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.cwd());
        const fileUri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.joinPath(defaultDir, `sidemu-${Date.now()}.png`),
          filters: { 'PNG Image': ['png'] },
        });
        if (!fileUri) {
          return;
        }
        await fs.promises.writeFile(fileUri.fsPath, Buffer.from(shot.base64, 'base64'));
        void vscode.window.showInformationMessage(`Saved screenshot to ${fileUri.fsPath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Screenshot failed: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('sidemu.showLogs', () => {
      log.show(true);
    }),
  );

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((ev) => {
      if (ev.affectsConfiguration('sidemu.mcpPort')) {
        void mcpHost
          .restart()
          .then((u) => provider.setMcpUrl(u))
          .catch((err) => log.error(`Failed to restart MCP server: ${String(err)}`));
      }
      if (ev.affectsConfiguration('sidemu.launchCommand')) {
        void dm.refreshLaunchTargets();
      }
      if (
        ev.affectsConfiguration('sidemu.mobilecliPath') ||
        ev.affectsConfiguration('sidemu.useDirenv') ||
        ev.affectsConfiguration('sidemu.androidHome') ||
        ev.affectsConfiguration('sidemu.avdHome')
      ) {
        void dm.refresh({ resolveEnvironment: true });
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void dm.refresh({ resolveEnvironment: true });
    }),
  );

  const flakeWatcher = vscode.workspace.createFileSystemWatcher('**/flake.{nix,lock}');
  ctx.subscriptions.push(
    flakeWatcher,
    flakeWatcher.onDidCreate(() => void dm.refresh({ resolveEnvironment: true })),
    flakeWatcher.onDidChange(() => void dm.refresh({ resolveEnvironment: true })),
    flakeWatcher.onDidDelete(() => void dm.refresh({ resolveEnvironment: true })),
  );

  dm.on('changed', () => {
    provider.pushState();
  });
  dm.on('cameOnline', (dev) => {
    const autoFocus = vscode.workspace
      .getConfiguration('sidemu')
      .get<boolean>('autoFocus', true);
    if (autoFocus) {
      dm.selectDevice(dev.id);
      void provider.focus().then(() => {
        provider.attach(dev.id);
      });
    }
  });
  dm.on('activeOffline', () => {
    provider.detach('Device went offline');
  });
  dm.on('overlay', (payload) => {
    provider.overlay(payload);
  });

  tracker.on('change', () => {
    dm.scheduleRefresh(300);
  });
  poller.on('change', () => {
    dm.scheduleRefresh(300);
  });

  void bridge.start().catch((err) => {
    log.error(`Failed to start stream bridge: ${String(err)}`);
  });
  void mcpHost
    .start()
    .then((url) => {
      provider.setMcpUrl(url);
    })
    .catch((err) => {
      log.error(`Failed to start MCP server: ${String(err)}`);
    });

  tracker.start();
  poller.start();

  // Never block activation on direnv, mobilecli, or nix evaluation
  void dm.refresh({ resolveEnvironment: true }).catch((err) => {
    log.error(`Initial refresh failed: ${String(err)}`);
  });
}

export async function deactivate(): Promise<void> {
  const services = activeServices;
  activeServices = null;
  if (!services) {
    return;
  }

  services.mcpHost.dispose();
  services.bridge.dispose();
  services.tracker.dispose();
  services.poller.dispose();

  const shutdownOnExit = vscode.workspace
    .getConfiguration('sidemu')
    .get<boolean>('shutdownOnExit', true);

  if (shutdownOnExit) {
    await services.dm.shutdownBootedDevices(3000);
  }

  await services.server.stop({ stopDaemon: true });
  services.dm.dispose();
}
