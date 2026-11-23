import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as vscode from 'vscode';
import { detectToolchain, resolveEnv } from '../env';
import { log } from '../log';
import { MobileCliServer } from '../mobilecli/server';
import {
  DeviceState,
  DeviceType,
  HardwareButton,
  LaunchTarget,
  OverlayPoint,
  Platform,
  SpecialKey,
  ToolchainStatus,
  UnifiedDevice,
} from '../shared/protocol';
import { adbShell, AdbTracker } from './adb';
import { discoverLocalAvds, LocalAvd, spawnLocalAvd } from './avd';
import { IosPoller } from './iosPoller';
import { detectLaunchTargets, killLaunchProcess, spawnLaunch } from './launch';

interface RawMobilecliDevice {
  id: string;
  name?: string;
  platform?: string;
  type?: string;
  state?: string;
  version?: string;
  model?: string;
}

export interface ScreenElement {
  ref?: string;
  type: string;
  label?: string;
  text?: string;
  name?: string;
  value?: string;
  placeholder?: string;
  identifier?: string;
  rect: { x: number; y: number; width: number; height: number };
  children?: ScreenElement[];
}

export interface CrashSummary {
  id: string;
  processName?: string;
  timestamp?: string;
}

export interface CrashReportContent extends CrashSummary {
  content: string;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function normalizeDevice(raw: RawMobilecliDevice): UnifiedDevice {
  const platform: Platform = raw.platform === 'ios' ? 'ios' : 'android';
  const type: DeviceType =
    raw.type === 'emulator' || raw.type === 'simulator' || raw.type === 'real'
      ? raw.type
      : platform === 'ios'
        ? 'simulator'
        : 'emulator';
  const state: DeviceState = raw.state === 'online' ? 'online' : 'offline';
  return {
    id: raw.id,
    name: raw.name || raw.id,
    platform,
    type,
    state,
    ...(raw.version ? { version: raw.version } : {}),
    ...(raw.model ? { model: raw.model } : {}),
  };
}

export class DeviceManager extends EventEmitter implements vscode.Disposable {
  public devices: UnifiedDevice[] = [];
  public launchTargets: LaunchTarget[] = [];
  public activeId: string | null = null;
  public toolchain: ToolchainStatus = { adb: false, xcrun: false, mobilecli: false };
  public busy: string | null = null;

  private readonly screenSizes = new Map<string, { width: number; height: number }>();
  private lastFrame: { width: number; height: number } | null = null;
  private readonly bootedBySidemu = new Set<string>();
  private readonly launchedProcs = new Map<string, ChildProcess>();
  private localAvds: LocalAvd[] = [];

  private lastResolvedEnv: NodeJS.ProcessEnv | null = null;
  private hasInitialSnapshot = false;
  private prevOnlineIds = new Set<string>();
  private refreshInFlight: Promise<void> | null = null;
  private pendingResolveEnv = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly server: MobileCliServer,
    private readonly adbTracker: AdbTracker,
    private readonly iosPoller?: IosPoller,
  ) {
    super();
    void this.iosPoller;
  }

  setLastFrameSize(width: number, height: number): void {
    if (width > 0 && height > 0) {
      this.lastFrame = { width, height };
    }
  }

  scheduleRefresh(delayMs = 300): void {
    if (this.disposed) {
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.refresh({ resolveEnvironment: false });
    }, delayMs);
  }

  async refresh(opts: { resolveEnvironment: boolean }): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (opts.resolveEnvironment) {
      this.pendingResolveEnv = true;
    }
    if (this.refreshInFlight) {
      await this.refreshInFlight;
      if (!this.pendingResolveEnv) {
        return;
      }
    }

    const runResolveEnv = opts.resolveEnvironment || this.pendingResolveEnv;
    this.pendingResolveEnv = false;

    const promise = this._refresh(runResolveEnv);
    this.refreshInFlight = promise;
    try {
      await promise;
    } finally {
      if (this.refreshInFlight === promise) {
        this.refreshInFlight = null;
      }
    }
  }

  private async _refresh(resolveEnvironment: boolean): Promise<void> {
    if (this.disposed) {
      return;
    }

    try {
      if (resolveEnvironment || !this.lastResolvedEnv) {
        const env = await resolveEnv();
        this.lastResolvedEnv = env;
        const tc = await detectToolchain(env);
        this.toolchain = {
          ...tc,
          mobilecli: this.toolchain.mobilecli,
          mobilecliError: this.toolchain.mobilecliError,
        };
        this.launchTargets = await detectLaunchTargets(env);
        this.localAvds = await discoverLocalAvds(env);
        await this.server.ensure(env);
        this.toolchain = { ...tc, mobilecli: true };
      }

      const res = await this.server.rpc<{ devices?: RawMobilecliDevice[] }>('devices.list', {
        includeOffline: true,
      });
      this.toolchain = { ...this.toolchain, mobilecli: true, mobilecliError: undefined };

      const normalized = (res.devices ?? []).map(normalizeDevice);
      for (const avd of this.localAvds) {
        const alreadyPresent = normalized.some(
          (d) => d.platform === 'android' && (d.id === avd.id || d.id === avd.avdId),
        );
        if (!alreadyPresent) {
          normalized.push({
            id: avd.id,
            name: avd.name,
            platform: 'android',
            type: 'emulator',
            state: 'offline',
            ...(avd.version ? { version: avd.version } : {}),
          });
        }
      }
      this.devices = normalized;

      const currentOnlineIds = new Set(
        normalized.filter((d) => d.state === 'online').map((d) => d.id),
      );

      for (const cachedId of this.screenSizes.keys()) {
        if (!currentOnlineIds.has(cachedId)) {
          this.screenSizes.delete(cachedId);
        }
      }

      if (!this.hasInitialSnapshot) {
        this.hasInitialSnapshot = true;
        if (!this.activeId) {
          const firstOnline = normalized.find((d) => d.state === 'online');
          if (firstOnline) {
            this.activeId = firstOnline.id;
          }
        }
      } else {
        if (this.activeId && this.prevOnlineIds.has(this.activeId) && !currentOnlineIds.has(this.activeId)) {
          this.emit('activeOffline', this.activeId);
        }
        for (const dev of normalized) {
          if (dev.state === 'online' && !this.prevOnlineIds.has(dev.id)) {
            this.emit('cameOnline', dev);
          }
        }
      }

      this.prevOnlineIds = currentOnlineIds;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Device refresh failed: ${msg}`);
      this.toolchain = {
        ...this.toolchain,
        mobilecli: false,
        mobilecliError: msg,
      };
    }

    this.emit('changed');
  }

  async refreshLaunchTargets(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const env = this.lastResolvedEnv ?? (await resolveEnv());
    this.lastResolvedEnv = env;
    this.launchTargets = await detectLaunchTargets(env);
    this.emit('changed');
  }

  selectDevice(id: string): void {
    const next = id || null;
    if (this.activeId !== next) {
      this.activeId = next;
      this.lastFrame = null;
      this.emit('changed');
    }
  }

  resolveTargetDeviceId(deviceId?: string): string {
    if (deviceId) {
      return deviceId;
    }
    if (this.activeId) {
      const activeOnline = this.devices.find(
        (d) => d.id === this.activeId && d.state === 'online',
      );
      if (activeOnline) {
        return activeOnline.id;
      }
    }
    const firstOnline = this.devices.find((d) => d.state === 'online');
    if (firstOnline) {
      return firstOnline.id;
    }
    throw new Error('No online device available. Boot an emulator/simulator or connect a device first.');
  }

  async getPlatform(deviceId: string): Promise<Platform> {
    const known = this.devices.find((d) => d.id === deviceId);
    if (known) {
      return known.platform;
    }
    const info = await this.server.rpc<{ device?: { platform?: string } }>('device.info', {
      deviceId,
    });
    return info.device?.platform === 'ios' ? 'ios' : 'android';
  }

  async screenSize(deviceId: string): Promise<{ width: number; height: number }> {
    const cached = this.screenSizes.get(deviceId);
    if (cached) {
      return cached;
    }
    const info = await this.server.rpc<{
      device?: { screenSize?: { width?: number; height?: number } };
    }>('device.info', { deviceId });

    const width = info.device?.screenSize?.width ?? 0;
    const height = info.device?.screenSize?.height ?? 0;
    if (width <= 0 || height <= 0) {
      throw new Error(`Invalid screen size reported for device "${deviceId}"`);
    }
    const size = { width, height };
    this.screenSizes.set(deviceId, size);
    return size;
  }

  async toDevicePoint(
    deviceId: string,
    nx: number,
    ny: number,
    frameW: number,
    frameH: number,
  ): Promise<{ x: number; y: number }> {
    const size = await this.screenSize(deviceId);
    const frameLandscape = frameW > 0 && frameH > 0 ? frameW > frameH : size.width > size.height;
    const sizeLandscape = size.width > size.height;
    const effW = frameLandscape !== sizeLandscape ? size.height : size.width;
    const effH = frameLandscape !== sizeLandscape ? size.width : size.height;
    return {
      x: Math.round(clamp(nx, 0, 1) * effW),
      y: Math.round(clamp(ny, 0, 1) * effH),
    };
  }

  async toNormalized(deviceId: string, x: number, y: number): Promise<OverlayPoint> {
    const size = await this.screenSize(deviceId);
    const frameLandscape = this.lastFrame
      ? this.lastFrame.width > this.lastFrame.height
      : size.width > size.height;
    const sizeLandscape = size.width > size.height;
    const effW = frameLandscape !== sizeLandscape ? size.height : size.width;
    const effH = frameLandscape !== sizeLandscape ? size.width : size.height;
    return {
      x: clamp(x / effW, 0, 1),
      y: clamp(y / effH, 0, 1),
    };
  }

  async tap(
    deviceId: string,
    x: number,
    y: number,
    source: 'agent' | 'user',
  ): Promise<void> {
    await this.server.rpc('device.io.tap', { deviceId, x, y });
    try {
      const pt = await this.toNormalized(deviceId, x, y);
      this.emit('overlay', { kind: 'tap', points: [pt], source });
    } catch {
      // Ignore overlay math error if device info is temporarily unavailable
    }
  }

  async longpress(
    deviceId: string,
    x: number,
    y: number,
    duration: number | undefined,
    source: 'agent' | 'user',
  ): Promise<void> {
    await this.server.rpc('device.io.longpress', {
      deviceId,
      x,
      y,
      ...(duration !== undefined ? { duration } : {}),
    });
    try {
      const pt = await this.toNormalized(deviceId, x, y);
      this.emit('overlay', { kind: 'longpress', points: [pt], source });
    } catch {
      // Ignore
    }
  }

  async swipe(
    deviceId: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration: number | undefined,
    source: 'agent' | 'user',
  ): Promise<void> {
    await this.server.rpc('device.io.swipe', {
      deviceId,
      x1,
      y1,
      x2,
      y2,
      ...(duration !== undefined ? { duration } : {}),
    });
    try {
      const [p1, p2] = await Promise.all([
        this.toNormalized(deviceId, x1, y1),
        this.toNormalized(deviceId, x2, y2),
      ]);
      this.emit('overlay', { kind: 'swipe', points: [p1, p2], source });
    } catch {
      // Ignore
    }
  }

  async typeText(deviceId: string, text: string): Promise<void> {
    await this.server.rpc('device.io.text', { deviceId, text });
  }

  async pressButton(
    deviceId: string,
    button: HardwareButton | 'ENTER' | 'BACKSPACE',
  ): Promise<void> {
    const platform = await this.getPlatform(deviceId);
    if (platform === 'ios' && (button === 'BACK' || button === 'APP_SWITCH')) {
      throw new Error(`Button "${button}" is only supported on Android devices.`);
    }
    if (platform === 'ios' && button === 'BACKSPACE') {
      await this.server.rpc('device.io.keys', { deviceId, keys: ['backspace'] });
      return;
    }
    await this.server.rpc('device.io.button', { deviceId, button });
  }

  async pressSpecialKey(deviceId: string, key: SpecialKey): Promise<void> {
    const platform = await this.getPlatform(deviceId);
    switch (key) {
      case 'ENTER':
        await this.pressButton(deviceId, 'ENTER');
        return;
      case 'BACKSPACE':
        await this.pressButton(deviceId, 'BACKSPACE');
        return;
      case 'ESCAPE':
        if (platform === 'android') {
          await this.pressButton(deviceId, 'BACK');
        }
        return;
      case 'UP':
      case 'DOWN':
      case 'LEFT':
      case 'RIGHT':
      case 'TAB':
        await this.server.rpc('device.io.keys', { deviceId, keys: [key.toLowerCase()] });
        return;
    }
  }

  async screenshot(
    deviceId: string,
    opts: { format: 'png' | 'jpeg'; maxSize?: number; quality?: number },
  ): Promise<{ format: 'png' | 'jpeg'; base64: string }> {
    const res = await this.server.rpc<{ format?: string; data: string }>('device.screenshot', {
      deviceId,
      format: opts.format,
      ...(opts.maxSize !== undefined ? { maxSize: opts.maxSize } : {}),
      ...(opts.quality !== undefined && opts.format === 'jpeg' ? { quality: opts.quality } : {}),
    });
    const base64 = res.data.replace(/^data:[^,]*,/, '');
    return {
      format: res.format === 'png' ? 'png' : 'jpeg',
      base64,
    };
  }

  async uiText(deviceId: string, full = false): Promise<string> {
    const res = await this.server.rpc<{ text?: string }>('device.dump.ui', {
      deviceId,
      format: 'text',
      full,
    });
    return res.text ?? '';
  }

  async uiElements(deviceId: string, full = false): Promise<ScreenElement[]> {
    const res = await this.server.rpc<{ elements?: ScreenElement[] }>('device.dump.ui', {
      deviceId,
      format: 'json',
      full,
    });
    return res.elements ?? [];
  }

  async openUrl(deviceId: string, url: string): Promise<void> {
    await this.server.rpc('device.url', { deviceId, url });
  }

  async crashLogs(deviceId: string, limit = 3): Promise<CrashReportContent[]> {
    const list = await this.server.rpc<CrashSummary[]>('device.crashes.list', { deviceId });
    if (!Array.isArray(list) || list.length === 0) {
      return [];
    }

    const sorted = [...list].sort((a, b) => {
      const ta = a.timestamp ? Date.parse(a.timestamp) : Number.NaN;
      const tb = b.timestamp ? Date.parse(b.timestamp) : Number.NaN;
      if (!Number.isNaN(ta) && !Number.isNaN(tb)) {
        return tb - ta;
      }
      return 0;
    });

    const picked = sorted.slice(0, limit);
    const reports: CrashReportContent[] = [];
    for (const item of picked) {
      const detail = await this.server.rpc<{ id?: string; content?: string }>('device.crashes.get', {
        deviceId,
        id: item.id,
      });
      reports.push({
        id: detail.id ?? item.id,
        processName: item.processName,
        timestamp: item.timestamp,
        content: detail.content ?? '',
      });
    }
    return reports;
  }

  async boot(idOrTarget: string, onFocus?: () => Promise<void>): Promise<string> {
    if (this.busy) {
      throw new Error(`Another device operation is already running: ${this.busy}`);
    }

    this.busy = `Booting ${idOrTarget}…`;
    this.emit('changed');

    try {
      const env = await resolveEnv();
      this.lastResolvedEnv = env;
      this.toolchain = { ...(await detectToolchain(env)), mobilecli: true };
      this.launchTargets = await detectLaunchTargets(env);
      await this.server.ensure(env);
      this.toolchain = { ...this.toolchain, mobilecli: true, mobilecliError: undefined };

      if (onFocus) {
        await onFocus();
      }

      if (idOrTarget.startsWith('launch:')) {
        const target = this.launchTargets.find((t) => t.id === idOrTarget);
        if (!target) {
          throw new Error(`Launch target "${idOrTarget}" is not available in this workspace.`);
        }
        return await this.bootLaunchTarget(target, env);
      }

      const existing = this.devices.find((d) => d.id === idOrTarget);
      if (existing && existing.state === 'online') {
        this.activeId = existing.id;
        return existing.id;
      }

      const localAvd = this.localAvds.find(
        (a) => a.id === idOrTarget || a.avdId === idOrTarget,
      );
      if (localAvd) {
        return await this.bootLocalAvd(localAvd, env);
      }

      await this.server.rpc('device.boot', { deviceId: idOrTarget });

      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        await this._refresh(false);
        const nowOnline = this.devices.find(
          (d) => d.id === idOrTarget && d.state === 'online',
        );
        if (nowOnline) {
          this.bootedBySidemu.add(nowOnline.id);
          this.activeId = nowOnline.id;
          return nowOnline.id;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      throw new Error(`Timed out waiting for "${idOrTarget}" to come online.`);
    } finally {
      this.busy = null;
      this.emit('changed');
    }
  }

  private async bootLaunchTarget(
    target: LaunchTarget,
    env: NodeJS.ProcessEnv,
  ): Promise<string> {
    return this.launchAndAwaitBoot({
      label: target.label,
      commandDesc: target.command,
      deadlineMs: 600_000,
      start: async () => spawnLaunch(target, env, this.server.shimDir),
    });
  }

  private async bootLocalAvd(avd: LocalAvd, env: NodeJS.ProcessEnv): Promise<string> {
    return this.launchAndAwaitBoot({
      label: `${avd.name} (${avd.id})`,
      commandDesc: `emulator -avd ${avd.id}`,
      deadlineMs: 300_000,
      preferredIds: [avd.id, avd.avdId],
      start: async () => spawnLocalAvd(avd, env),
    });
  }

  private async launchAndAwaitBoot(opts: {
    label: string;
    commandDesc: string;
    deadlineMs: number;
    preferredIds?: string[];
    start: () => Promise<{ child: ChildProcess; outputTail: () => string }>;
  }): Promise<string> {
    await this._refresh(false);
    const baselineOnlineIds = new Set(
      this.devices.filter((d) => d.platform === 'android' && d.state === 'online').map((d) => d.id),
    );
    const baselineAdbOnline = new Set<string>();
    for (const [serial, state] of this.adbTracker.getDevices()) {
      if (state === 'device') {
        baselineAdbOnline.add(serial);
      }
    }

    this.busy = `Launching ${opts.label}…`;
    this.emit('changed');

    const { child, outputTail } = await opts.start();
    const totalDeadline = Date.now() + opts.deadlineMs;

    let earlyExitErr: Error | null = null;
    const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const tail = outputTail();
      earlyExitErr = new Error(
        `Launch command "${opts.commandDesc}" exited before emulator booted (code=${code ?? 'null'}, signal=${signal ?? 'null'})${tail ? `:\n${tail}` : ''}`,
      );
    };
    const onChildError = (err: Error) => {
      earlyExitErr = new Error(`Failed to spawn "${opts.commandDesc}": ${err.message}`);
    };
    child.once('exit', onChildExit);
    child.once('error', onChildError);

    try {
      this.busy = 'Waiting for emulator on ADB…';
      this.emit('changed');

      const newSerial = await this.waitForNewAdbSerial(
        baselineAdbOnline,
        totalDeadline,
        () => earlyExitErr,
      );

      this.busy = `Waiting for Android to finish booting (${newSerial})…`;
      this.emit('changed');

      while (Date.now() < totalDeadline) {
        if (earlyExitErr) {
          throw earlyExitErr;
        }
        try {
          const prop = await adbShell(newSerial, 'getprop sys.boot_completed', 3000);
          if (prop.trim() === '1') {
            break;
          }
        } catch {
          // Shell not ready yet
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      if (earlyExitErr) {
        throw earlyExitErr;
      }
      if (Date.now() >= totalDeadline) {
        throw new Error(`Timed out waiting for Android sys.boot_completed on ${newSerial}.`);
      }

      const listDeadline = Math.min(totalDeadline, Date.now() + 15_000);
      let bootedDevice: UnifiedDevice | undefined;
      while (Date.now() < listDeadline) {
        await this._refresh(false);
        bootedDevice =
          (opts.preferredIds
            ? this.devices.find(
                (d) =>
                  d.platform === 'android' &&
                  d.state === 'online' &&
                  opts.preferredIds!.includes(d.id),
              )
            : undefined) ??
          this.devices.find(
            (d) => d.platform === 'android' && d.state === 'online' && !baselineOnlineIds.has(d.id),
          ) ??
          this.devices.find(
            (d) => d.platform === 'android' && d.type === 'emulator' && d.state === 'online',
          );
        if (bootedDevice) {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      if (!bootedDevice) {
        const hint = !this.toolchain.adb
          ? ' mobilecli has no adb client in this environment; add Android platform-tools to your devShell or set ANDROID_HOME, then press Refresh.'
          : '';
        throw new Error(
          `Emulator (${newSerial}) booted on ADB, but did not appear in mobilecli devices list.${hint}`,
        );
      }

      child.removeListener('exit', onChildExit);
      child.removeListener('error', onChildError);

      this.launchedProcs.set(bootedDevice.id, child);
      child.once('exit', () => {
        if (this.launchedProcs.get(bootedDevice!.id) === child) {
          this.launchedProcs.delete(bootedDevice!.id);
        }
      });

      this.bootedBySidemu.add(bootedDevice.id);
      this.activeId = bootedDevice.id;
      return bootedDevice.id;
    } catch (err) {
      child.removeListener('exit', onChildExit);
      child.removeListener('error', onChildError);
      killLaunchProcess(child);
      throw err;
    }
  }

  private waitForNewAdbSerial(
    baselineOnline: Set<string>,
    deadline: number,
    getEarlyExit: () => Error | null,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const exitErr = getEarlyExit();
        if (exitErr) {
          cleanup();
          reject(exitErr);
          return;
        }
        for (const [serial, state] of this.adbTracker.getDevices()) {
          if (state === 'device' && !baselineOnline.has(serial)) {
            cleanup();
            resolve(serial);
            return;
          }
        }
        if (Date.now() >= deadline) {
          cleanup();
          const msg = !this.adbTracker.connected
            ? 'No ADB server is running on 127.0.0.1:5037, so the launched emulator could not be discovered. Make sure your launch command starts "adb start-server" (lib.mkSidebarEmulator does this) and that adb is in your devShell (e.g. add <emulator>.platformTools / set ANDROID_HOME).'
            : 'Timed out waiting for the launched emulator to appear on ADB.';
          reject(new Error(msg));
        }
      };

      const onChange = () => check();
      const pollTimer = setInterval(check, 500);
      this.adbTracker.on('change', onChange);

      const cleanup = () => {
        clearInterval(pollTimer);
        this.adbTracker.removeListener('change', onChange);
      };

      check();
    });
  }

  async shutdown(deviceId: string): Promise<void> {
    this.busy = `Shutting down ${deviceId}…`;
    this.emit('changed');

    try {
      await this.server.rpc('device.shutdown', { deviceId }).catch((err) => {
        log.warn(`device.shutdown warning for ${deviceId}: ${String(err)}`);
      });
      const proc = this.launchedProcs.get(deviceId);
      if (proc) {
        killLaunchProcess(proc);
        this.launchedProcs.delete(deviceId);
      }
      this.bootedBySidemu.delete(deviceId);
      this.screenSizes.delete(deviceId);
      await this._refresh(false);
    } finally {
      this.busy = null;
      this.emit('changed');
    }
  }

  async shutdownBootedDevices(maxMs = 3000): Promise<void> {
    const ids = Array.from(this.bootedBySidemu);
    const procs = Array.from(this.launchedProcs.values());

    if (ids.length === 0 && procs.length === 0) {
      return;
    }

    const work = (async () => {
      await Promise.allSettled(
        ids.map((id) => this.server.rpc('device.shutdown', { deviceId: id }, maxMs)),
      );
      for (const proc of procs) {
        killLaunchProcess(proc);
      }
    })();

    await Promise.race([work, new Promise<void>((r) => setTimeout(r, maxMs))]);
    this.bootedBySidemu.clear();
    this.launchedProcs.clear();
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.removeAllListeners();
  }
}
