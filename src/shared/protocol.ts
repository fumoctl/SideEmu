export type Platform = 'android' | 'ios';
export type DeviceType = 'emulator' | 'simulator' | 'real';
export type DeviceState = 'online' | 'offline';

export type HardwareButton =
  | 'HOME'
  | 'POWER'
  | 'VOLUME_UP'
  | 'VOLUME_DOWN'
  | 'BACK'
  | 'APP_SWITCH';

export type SpecialKey =
  | 'ENTER'
  | 'BACKSPACE'
  | 'ESCAPE'
  | 'UP'
  | 'DOWN'
  | 'LEFT'
  | 'RIGHT'
  | 'TAB';

export interface UnifiedDevice {
  id: string;
  name: string;
  platform: Platform;
  type: DeviceType;
  state: DeviceState;
  version?: string;
  model?: string;
}

export interface LaunchTarget {
  id: 'launch:setting' | 'launch:flake';
  label: string;
  command: string;
  source: 'setting' | 'flake';
}

export interface ToolchainStatus {
  adb: boolean;
  xcrun: boolean;
  mobilecli: boolean;
  mobilecliError?: string;
}

export interface OverlayPoint {
  x: number;
  y: number;
}

export type ExtToWebview =
  | {
      type: 'state';
      devices: UnifiedDevice[];
      launchTargets: LaunchTarget[];
      activeId: string | null;
      toolchain: ToolchainStatus;
      mcpUrl: string | null;
      busy: string | null;
    }
  | {
      type: 'attach';
      deviceId: string;
      platform: Platform;
      streamUrl: string;
    }
  | {
      type: 'detach';
      reason: string;
    }
  | {
      type: 'overlay';
      kind: 'tap' | 'swipe' | 'longpress';
      points: OverlayPoint[];
      source: 'agent' | 'user';
    }
  | {
      type: 'status';
      level: 'info' | 'progress' | 'error';
      text: string;
    };

export type WebviewToExt =
  | { type: 'ready' }
  | { type: 'selectDevice'; id: string }
  | { type: 'boot'; id: string }
  | { type: 'shutdown'; id: string }
  | { type: 'refresh' }
  | { type: 'tap'; x: number; y: number; frameW: number; frameH: number }
  | { type: 'longpress'; x: number; y: number; durationMs: number; frameW: number; frameH: number }
  | {
      type: 'swipe';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      durationMs: number;
      frameW: number;
      frameH: number;
    }
  | { type: 'text'; text: string }
  | { type: 'key'; key: SpecialKey }
  | { type: 'button'; button: HardwareButton }
  | { type: 'frameSize'; width: number; height: number }
  | { type: 'screenshot' }
  | { type: 'copyMcpConfig' };
