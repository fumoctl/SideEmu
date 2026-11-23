import {
  ExtToWebview,
  HardwareButton,
  LaunchTarget,
  OverlayPoint,
  Platform,
  SpecialKey,
  ToolchainStatus,
  UnifiedDevice,
  WebviewToExt,
} from '../shared/protocol';

interface VsCodeApi {
  postMessage(message: WebviewToExt): void;
  getState(): { selectedId?: string } | undefined;
  setState(state: { selectedId?: string }): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

interface ViewState {
  devices: UnifiedDevice[];
  launchTargets: LaunchTarget[];
  activeId: string | null;
  toolchain: ToolchainStatus;
  mcpUrl: string | null;
  busy: string | null;
}

interface OverlayAnimation {
  kind: 'tap' | 'swipe' | 'longpress';
  points: OverlayPoint[];
  source: 'agent' | 'user';
  startMs: number;
  durationMs: number;
}

const SPECIAL_KEYS: Record<string, SpecialKey> = {
  Enter: 'ENTER',
  Backspace: 'BACKSPACE',
  Escape: 'ESCAPE',
  ArrowUp: 'UP',
  ArrowDown: 'DOWN',
  ArrowLeft: 'LEFT',
  ArrowRight: 'RIGHT',
  Tab: 'TAB',
};

const app = document.getElementById('app')!;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

// Toolbar construction
const toolbar = el('div', 'toolbar');
const row1 = el('div', 'toolbar-row');
const deviceSelect = el('select', 'device-select');
deviceSelect.title = 'Select mobile device or emulator launch target';

const bootBtn = el('button', 'btn primary', 'Boot');
bootBtn.type = 'button';
bootBtn.title = 'Boot selected emulator/simulator or launch target';

const stopBtn = el('button', 'btn', 'Stop');
stopBtn.type = 'button';
stopBtn.title = 'Shut down selected emulator/simulator';

const refreshBtn = el('button', 'btn icon-btn', '↻');
refreshBtn.type = 'button';
refreshBtn.title = 'Refresh devices';

row1.append(deviceSelect, bootBtn, stopBtn, refreshBtn);

const row2 = el('div', 'toolbar-row');
const backBtn = el('button', 'btn icon-btn', '◀');
backBtn.type = 'button';
backBtn.title = 'Back (Android)';

const homeBtn = el('button', 'btn icon-btn', '●');
homeBtn.type = 'button';
homeBtn.title = 'Home';

const appSwitchBtn = el('button', 'btn icon-btn', '▢');
appSwitchBtn.type = 'button';
appSwitchBtn.title = 'App Switch (Android)';

const powerBtn = el('button', 'btn icon-btn', '⏻');
powerBtn.type = 'button';
powerBtn.title = 'Power';

const volUpBtn = el('button', 'btn icon-btn', '🔊+');
volUpBtn.type = 'button';
volUpBtn.title = 'Volume Up';

const volDownBtn = el('button', 'btn icon-btn', '🔊-');
volDownBtn.type = 'button';
volDownBtn.title = 'Volume Down';

const screenshotBtn = el('button', 'btn icon-btn', '📷');
screenshotBtn.type = 'button';
screenshotBtn.title = 'Save Screenshot';

const mcpPill = el('button', 'mcp-pill', 'MCP: starting…');
mcpPill.type = 'button';
mcpPill.title = 'Copy MCP Server Config';

row2.append(
  backBtn,
  homeBtn,
  appSwitchBtn,
  powerBtn,
  volUpBtn,
  volDownBtn,
  screenshotBtn,
  mcpPill,
);
toolbar.append(row1, row2);

// Stage & canvases
const stage = el('div', 'stage');
const canvasWrap = el('div', 'canvas-wrap');
const screenCanvas = el('canvas');
screenCanvas.id = 'screen';
screenCanvas.tabIndex = 0;
const fxCanvas = el('canvas');
fxCanvas.id = 'fx';
canvasWrap.append(screenCanvas, fxCanvas);

const messageBox = el('div', 'message-overlay');
stage.append(canvasWrap, messageBox);
app.append(toolbar, stage);

const screenCtx = screenCanvas.getContext('2d')!;
const fxCtx = fxCanvas.getContext('2d')!;

let currentState: ViewState = {
  devices: [],
  launchTargets: [],
  activeId: vscode.getState()?.selectedId ?? null,
  toolchain: { adb: true, xcrun: false, mobilecli: true },
  mcpUrl: null,
  busy: null,
};

let attached: { deviceId: string; platform: Platform; streamUrl: string } | null = null;
let streamAbort: AbortController | null = null;
let reconnectTimer: number | null = null;
let reconnectBackoffMs = 1000;
let frameW = 0;
let frameH = 0;
let pendingFrame: Uint8Array | null = null;
let decoding = false;

let textBuffer = '';
let textFlushTimer: number | null = null;

let dragState: {
  pointerId: number;
  startNormX: number;
  startNormY: number;
  startClientX: number;
  startClientY: number;
  currNormX: number;
  currNormY: number;
  startTime: number;
} | null = null;

const overlays: OverlayAnimation[] = [];
let fxRafId: number | null = null;

function setMessage(level: 'info' | 'progress' | 'error' | 'hidden', text = '', subtle = false): void {
  if (level === 'hidden' || !text) {
    messageBox.className = 'message-overlay hidden';
    messageBox.textContent = '';
    return;
  }
  const classes = ['message-overlay'];
  if (level === 'error') {
    classes.push('error');
  }
  if (subtle) {
    classes.push('subtle');
  }
  messageBox.className = classes.join(' ');
  messageBox.textContent = text;
}

function layoutCanvases(): void {
  const availW = Math.max(80, stage.clientWidth - 12);
  const availH = Math.max(80, stage.clientHeight - 12);
  if (frameW <= 0 || frameH <= 0) {
    canvasWrap.classList.add('hidden');
    return;
  }
  canvasWrap.classList.remove('hidden');
  const scale = Math.min(availW / frameW, availH / frameH);
  const cssW = Math.max(1, Math.floor(frameW * scale));
  const cssH = Math.max(1, Math.floor(frameH * scale));
  screenCanvas.style.width = `${cssW}px`;
  screenCanvas.style.height = `${cssH}px`;
  fxCanvas.style.width = `${cssW}px`;
  fxCanvas.style.height = `${cssH}px`;
}

new ResizeObserver(() => layoutCanvases()).observe(stage);

function effectiveSelectedId(): string | null {
  return currentState.activeId ?? deviceSelect.value ?? null;
}

function renderState(): void {
  const selectedId = currentState.activeId ?? vscode.getState()?.selectedId ?? '';
  deviceSelect.textContent = '';

  const android = currentState.devices.filter((d) => d.platform === 'android');
  const ios = currentState.devices.filter((d) => d.platform === 'ios');

  const appendGroup = (label: string, items: UnifiedDevice[]) => {
    if (items.length === 0) {
      return;
    }
    const group = document.createElement('optgroup');
    group.label = label;
    for (const dev of items) {
      const opt = document.createElement('option');
      opt.value = dev.id;
      const dot = dev.state === 'online' ? '●' : '○';
      const suffix = dev.state === 'offline' ? ' — offline' : '';
      opt.textContent = `${dot} ${dev.name} (${dev.type})${suffix}`;
      group.appendChild(opt);
    }
    deviceSelect.appendChild(group);
  };

  appendGroup('Android', android);
  appendGroup('iOS', ios);

  if (currentState.launchTargets.length > 0) {
    const group = document.createElement('optgroup');
    group.label = 'Launch Targets';
    for (const target of currentState.launchTargets) {
      const opt = document.createElement('option');
      opt.value = target.id;
      opt.textContent = `▶ ${target.label}`;
      group.appendChild(opt);
    }
    deviceSelect.appendChild(group);
  }

  if (deviceSelect.options.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No devices available';
    opt.disabled = true;
    deviceSelect.appendChild(opt);
  } else if (selectedId) {
    const hasMatch = Array.from(deviceSelect.options).some((o) => o.value === selectedId);
    if (hasMatch) {
      deviceSelect.value = selectedId;
    }
  }

  const val = deviceSelect.value;
  const selectedDev = currentState.devices.find((d) => d.id === val);
  const selectedTarget = currentState.launchTargets.find((t) => t.id === val);
  const busy = Boolean(currentState.busy);

  bootBtn.disabled =
    busy ||
    !(
      Boolean(selectedTarget) ||
      Boolean(selectedDev && selectedDev.state === 'offline' && selectedDev.type !== 'real')
    );

  stopBtn.disabled =
    busy || !(Boolean(selectedDev) && selectedDev!.state === 'online' && selectedDev!.type !== 'real');

  const activePlatform: Platform = attached?.platform ?? selectedDev?.platform ?? 'android';
  const isIos = activePlatform === 'ios';
  backBtn.classList.toggle('hidden', isIos);
  appSwitchBtn.classList.toggle('hidden', isIos);

  const controlsDisabled = !attached;
  for (const btn of [backBtn, homeBtn, appSwitchBtn, powerBtn, volUpBtn, volDownBtn, screenshotBtn]) {
    btn.disabled = controlsDisabled;
  }

  mcpPill.textContent = currentState.mcpUrl
    ? `MCP: ${currentState.mcpUrl.replace(/^http:\/\//, '')}`
    : 'MCP: unavailable';

  updateIdleMessage();
}

function updateIdleMessage(): void {
  if (currentState.busy) {
    setMessage('progress', currentState.busy, Boolean(attached));
    return;
  }

  const tc = currentState.toolchain;
  if (tc.mobilecliError) {
    setMessage('error', `mobilecli error: ${tc.mobilecliError}`);
    return;
  }

  if (!tc.adb && !tc.xcrun && currentState.devices.length === 0 && currentState.launchTargets.length === 0) {
    setMessage(
      'error',
      'Neither Android SDK (adb) nor Xcode (xcrun) was found in this environment. Install one or open a workspace whose Nix devShell / direnv provides them (with ANDROID_HOME set), then press Refresh.',
    );
    return;
  }

  if (!attached) {
    if (currentState.devices.length === 0 && currentState.launchTargets.length === 0) {
      setMessage(
        'info',
        'No emulators, simulators, or devices detected. Connect a device, create an AVD, or open a Nix flake workspace, then click Refresh.',
      );
    } else {
      setMessage('info', 'Select an online device to mirror, or choose an offline target and click Boot.');
    }
  }
}

function clearStream(): void {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (streamAbort) {
    streamAbort.abort();
    streamAbort = null;
  }
  pendingFrame = null;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) {
    return b;
  }
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function findSequence(buf: Uint8Array, seq: number[], start = 0): number {
  const limit = buf.length - seq.length;
  for (let i = start; i <= limit; i += 1) {
    let match = true;
    for (let j = 0; j < seq.length; j += 1) {
      if (buf[i + j] !== seq[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      return i;
    }
  }
  return -1;
}

function handlePreambleText(bytes: Uint8Array): void {
  if (bytes.length === 0) {
    return;
  }
  const text = new TextDecoder().decode(bytes);
  const matches = text.match(/\{"jsonrpc"[^\r\n]*\}/g);
  if (!matches) {
    return;
  }
  for (const raw of matches) {
    try {
      const parsed = JSON.parse(raw) as { params?: { message?: string } };
      const msg = parsed.params?.message ?? (parsed.params ? JSON.stringify(parsed.params) : '');
      if (msg) {
        setMessage('progress', msg, true);
      }
    } catch {
      // Ignore partial JSON lines
    }
  }
}

async function drainFrameQueue(): Promise<void> {
  decoding = true;
  try {
    while (pendingFrame !== null && attached !== null) {
      const frame = pendingFrame;
      pendingFrame = null;
      try {
        const blob = new Blob([frame.slice().buffer], { type: 'image/jpeg' });
        const bitmap = await createImageBitmap(blob);
        if (!attached) {
          bitmap.close();
          break;
        }
        reconnectBackoffMs = 1000;
        if (!currentState.busy) {
          setMessage('hidden');
        }
        if (bitmap.width !== frameW || bitmap.height !== frameH) {
          frameW = bitmap.width;
          frameH = bitmap.height;
          screenCanvas.width = frameW;
          screenCanvas.height = frameH;
          fxCanvas.width = frameW;
          fxCanvas.height = frameH;
          layoutCanvases();
          vscode.postMessage({ type: 'frameSize', width: frameW, height: frameH });
        }
        screenCtx.drawImage(bitmap, 0, 0);
        bitmap.close();
      } catch {
        // Skip malformed JPEG frame
      }
    }
  } finally {
    decoding = false;
  }
}

function enqueueFrame(frame: Uint8Array): void {
  pendingFrame = frame;
  if (!decoding) {
    void drainFrameQueue();
  }
}

async function runStream(targetDeviceId: string, streamUrl: string): Promise<void> {
  clearStream();
  const controller = new AbortController();
  streamAbort = controller;

  try {
    setMessage('progress', 'Connecting to device stream…', frameW > 0);
    const res = await fetch(streamUrl, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok || !res.body) {
      throw new Error(`Stream HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    let buffer: Uint8Array = new Uint8Array(0);

    while (!controller.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }

      buffer = concatBytes(buffer, value);
      if (buffer.length > 16 * 1024 * 1024) {
        buffer = new Uint8Array(0);
        continue;
      }

      while (true) {
        const soi = findSequence(buffer, [0xff, 0xd8, 0xff]);
        if (soi === -1) {
          if (buffer.length > 2048) {
            handlePreambleText(buffer.subarray(0, buffer.length - 3));
            buffer = buffer.subarray(buffer.length - 3);
          }
          break;
        }
        if (soi > 0) {
          handlePreambleText(buffer.subarray(0, soi));
          buffer = buffer.subarray(soi);
        }
        const eoi = findSequence(buffer, [0xff, 0xd9], 3);
        if (eoi === -1) {
          break;
        }
        const frame = buffer.slice(0, eoi + 2);
        buffer = buffer.subarray(eoi + 2);
        enqueueFrame(frame);
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      return;
    }
    const text = err instanceof Error ? err.message : String(err);
    setMessage('progress', `Stream interrupted (${text}); reconnecting…`, frameW > 0);
  }

  if (!controller.signal.aborted && attached && attached.deviceId === targetDeviceId) {
    const delay = reconnectBackoffMs;
    reconnectBackoffMs = Math.min(5000, reconnectBackoffMs * 2);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      if (attached && attached.deviceId === targetDeviceId) {
        void runStream(targetDeviceId, attached.streamUrl);
      }
    }, delay);
  }
}

// Overlay rendering
function cssVarColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function addOverlay(
  kind: 'tap' | 'swipe' | 'longpress',
  points: OverlayPoint[],
  source: 'agent' | 'user',
): void {
  overlays.push({
    kind,
    points,
    source,
    startMs: performance.now(),
    durationMs: kind === 'swipe' ? 700 : kind === 'longpress' ? 750 : 600,
  });
  scheduleFxFrame();
}

function scheduleFxFrame(): void {
  if (fxRafId === null) {
    fxRafId = window.requestAnimationFrame(renderFx);
  }
}

function renderFx(now: number): void {
  fxRafId = null;
  if (fxCanvas.width <= 0 || fxCanvas.height <= 0) {
    return;
  }
  fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);

  const agentColor = cssVarColor('--vscode-charts-purple', '#a855f7');
  const userColor = cssVarColor('--vscode-focusBorder', '#3b82f6');

  let activeCount = 0;
  for (let i = overlays.length - 1; i >= 0; i -= 1) {
    const item = overlays[i]!;
    const elapsed = now - item.startMs;
    if (elapsed >= item.durationMs) {
      overlays.splice(i, 1);
      continue;
    }
    activeCount += 1;
    const t = elapsed / item.durationMs;
    const alpha = Math.max(0, 1 - t);
    const color = item.source === 'agent' ? agentColor : userColor;
    const baseRadius = Math.max(12, Math.min(fxCanvas.width, fxCanvas.height) * 0.035);

    fxCtx.save();
    fxCtx.globalAlpha = alpha;
    fxCtx.strokeStyle = color;
    fxCtx.fillStyle = color;
    fxCtx.lineWidth = Math.max(2, fxCanvas.width * 0.005);

    if ((item.kind === 'tap' || item.kind === 'longpress') && item.points[0]) {
      const px = item.points[0].x * fxCanvas.width;
      const py = item.points[0].y * fxCanvas.height;
      const r = baseRadius * (0.4 + 1.4 * t);
      fxCtx.beginPath();
      fxCtx.arc(px, py, r, 0, Math.PI * 2);
      fxCtx.stroke();

      fxCtx.beginPath();
      fxCtx.arc(px, py, Math.max(3, baseRadius * 0.25), 0, Math.PI * 2);
      fxCtx.fill();

      if (item.source === 'agent') {
        drawAiBadge(px + baseRadius * 0.8, py - baseRadius * 0.8, color);
      }
    } else if (item.kind === 'swipe' && item.points[0] && item.points[1]) {
      const x1 = item.points[0].x * fxCanvas.width;
      const y1 = item.points[0].y * fxCanvas.height;
      const x2 = item.points[1].x * fxCanvas.width;
      const y2 = item.points[1].y * fxCanvas.height;

      fxCtx.beginPath();
      fxCtx.moveTo(x1, y1);
      fxCtx.lineTo(x2, y2);
      fxCtx.stroke();

      const angle = Math.atan2(y2 - y1, x2 - x1);
      const headLen = Math.max(10, baseRadius * 0.8);
      fxCtx.beginPath();
      fxCtx.moveTo(x2, y2);
      fxCtx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
      fxCtx.moveTo(x2, y2);
      fxCtx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
      fxCtx.stroke();

      if (item.source === 'agent') {
        drawAiBadge(x1, y1 - baseRadius * 0.6, color);
      }
    }
    fxCtx.restore();
  }

  if (dragState) {
    activeCount += 1;
    const x1 = dragState.startNormX * fxCanvas.width;
    const y1 = dragState.startNormY * fxCanvas.height;
    const x2 = dragState.currNormX * fxCanvas.width;
    const y2 = dragState.currNormY * fxCanvas.height;
    fxCtx.save();
    fxCtx.strokeStyle = userColor;
    fxCtx.lineWidth = Math.max(2, fxCanvas.width * 0.005);
    fxCtx.setLineDash([6, 4]);
    fxCtx.beginPath();
    fxCtx.moveTo(x1, y1);
    fxCtx.lineTo(x2, y2);
    fxCtx.stroke();
    fxCtx.restore();
  }

  if (activeCount > 0) {
    scheduleFxFrame();
  }
}

function drawAiBadge(x: number, y: number, color: string): void {
  const fontSize = Math.max(11, Math.round(fxCanvas.width * 0.032));
  fxCtx.font = `700 ${fontSize}px sans-serif`;
  const padX = 4;
  const textW = fxCtx.measureText('AI').width;
  const boxW = textW + padX * 2;
  const boxH = fontSize + 4;
  const bx = Math.min(fxCanvas.width - boxW - 2, Math.max(2, x));
  const by = Math.min(fxCanvas.height - boxH - 2, Math.max(2, y));
  fxCtx.fillStyle = color;
  fxCtx.fillRect(bx, by, boxW, boxH);
  fxCtx.fillStyle = '#ffffff';
  fxCtx.textBaseline = 'top';
  fxCtx.fillText('AI', bx + padX, by + 2);
}

// Toolbar event listeners
deviceSelect.addEventListener('change', () => {
  const id = deviceSelect.value;
  vscode.setState({ selectedId: id });
  vscode.postMessage({ type: 'selectDevice', id });
});

bootBtn.addEventListener('click', () => {
  const id = effectiveSelectedId();
  if (id) {
    vscode.postMessage({ type: 'boot', id });
  }
});

stopBtn.addEventListener('click', () => {
  const id = effectiveSelectedId();
  if (id) {
    vscode.postMessage({ type: 'shutdown', id });
  }
});

refreshBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'refresh' });
});

function bindButton(btn: HTMLButtonElement, button: HardwareButton): void {
  btn.addEventListener('click', () => {
    vscode.postMessage({ type: 'button', button });
  });
}

bindButton(backBtn, 'BACK');
bindButton(homeBtn, 'HOME');
bindButton(appSwitchBtn, 'APP_SWITCH');
bindButton(powerBtn, 'POWER');
bindButton(volUpBtn, 'VOLUME_UP');
bindButton(volDownBtn, 'VOLUME_DOWN');

screenshotBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'screenshot' });
});

mcpPill.addEventListener('click', () => {
  vscode.postMessage({ type: 'copyMcpConfig' });
});

// Pointer interactions on canvas
function normalizedFromPointer(ev: PointerEvent): OverlayPoint {
  const w = screenCanvas.clientWidth || 1;
  const h = screenCanvas.clientHeight || 1;
  return {
    x: Math.max(0, Math.min(1, ev.offsetX / w)),
    y: Math.max(0, Math.min(1, ev.offsetY / h)),
  };
}

screenCanvas.addEventListener('pointerdown', (ev: PointerEvent) => {
  if (ev.button !== 0 || !attached || frameW <= 0 || frameH <= 0) {
    return;
  }
  screenCanvas.focus();
  screenCanvas.setPointerCapture(ev.pointerId);
  const pt = normalizedFromPointer(ev);
  dragState = {
    pointerId: ev.pointerId,
    startNormX: pt.x,
    startNormY: pt.y,
    startClientX: ev.clientX,
    startClientY: ev.clientY,
    currNormX: pt.x,
    currNormY: pt.y,
    startTime: Date.now(),
  };
  scheduleFxFrame();
});

screenCanvas.addEventListener('pointermove', (ev: PointerEvent) => {
  if (!dragState || dragState.pointerId !== ev.pointerId) {
    return;
  }
  const pt = normalizedFromPointer(ev);
  dragState.currNormX = pt.x;
  dragState.currNormY = pt.y;
  scheduleFxFrame();
});

screenCanvas.addEventListener('pointerup', (ev: PointerEvent) => {
  if (!dragState || dragState.pointerId !== ev.pointerId) {
    return;
  }
  const current = dragState;
  dragState = null;
  const pt = normalizedFromPointer(ev);
  const dist = Math.hypot(ev.clientX - current.startClientX, ev.clientY - current.startClientY);
  const elapsed = Date.now() - current.startTime;

  if (dist < 8) {
    if (elapsed >= 500) {
      const durationMs = Math.min(elapsed, 3000);
      vscode.postMessage({
        type: 'longpress',
        x: current.startNormX,
        y: current.startNormY,
        durationMs,
        frameW,
        frameH,
      });
      addOverlay('longpress', [{ x: current.startNormX, y: current.startNormY }], 'user');
    } else {
      vscode.postMessage({
        type: 'tap',
        x: current.startNormX,
        y: current.startNormY,
        frameW,
        frameH,
      });
      addOverlay('tap', [{ x: current.startNormX, y: current.startNormY }], 'user');
    }
  } else {
    const durationMs = Math.max(100, Math.min(2000, elapsed));
    vscode.postMessage({
      type: 'swipe',
      x1: current.startNormX,
      y1: current.startNormY,
      x2: pt.x,
      y2: pt.y,
      durationMs,
      frameW,
      frameH,
    });
    addOverlay(
      'swipe',
      [
        { x: current.startNormX, y: current.startNormY },
        { x: pt.x, y: pt.y },
      ],
      'user',
    );
  }
  scheduleFxFrame();
});

screenCanvas.addEventListener('pointercancel', () => {
  dragState = null;
  scheduleFxFrame();
});

// Keyboard interactions
function flushTextBuffer(): void {
  if (textFlushTimer !== null) {
    window.clearTimeout(textFlushTimer);
    textFlushTimer = null;
  }
  if (textBuffer) {
    const text = textBuffer;
    textBuffer = '';
    vscode.postMessage({ type: 'text', text });
  }
}

screenCanvas.addEventListener('keydown', (ev: KeyboardEvent) => {
  if (!attached) {
    return;
  }
  const special = SPECIAL_KEYS[ev.key];
  if (special) {
    ev.preventDefault();
    flushTextBuffer();
    vscode.postMessage({ type: 'key', key: special });
    return;
  }
  if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    ev.preventDefault();
    textBuffer += ev.key;
    if (textFlushTimer !== null) {
      window.clearTimeout(textFlushTimer);
    }
    textFlushTimer = window.setTimeout(flushTextBuffer, 60);
  }
});

screenCanvas.addEventListener('paste', (ev: ClipboardEvent) => {
  if (!attached) {
    return;
  }
  const text = ev.clipboardData?.getData('text');
  if (text) {
    ev.preventDefault();
    flushTextBuffer();
    vscode.postMessage({ type: 'text', text });
  }
});

// Extension -> Webview messages
window.addEventListener('message', (event: MessageEvent<ExtToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'state': {
      currentState = {
        devices: msg.devices,
        launchTargets: msg.launchTargets,
        activeId: msg.activeId,
        toolchain: msg.toolchain,
        mcpUrl: msg.mcpUrl,
        busy: msg.busy,
      };
      if (msg.activeId) {
        vscode.setState({ selectedId: msg.activeId });
      }
      renderState();
      break;
    }
    case 'attach': {
      attached = {
        deviceId: msg.deviceId,
        platform: msg.platform,
        streamUrl: msg.streamUrl,
      };
      reconnectBackoffMs = 1000;
      renderState();
      void runStream(msg.deviceId, msg.streamUrl);
      break;
    }
    case 'detach': {
      attached = null;
      clearStream();
      frameW = 0;
      frameH = 0;
      screenCanvas.width = 0;
      screenCanvas.height = 0;
      fxCanvas.width = 0;
      fxCanvas.height = 0;
      layoutCanvases();
      renderState();
      if (msg.reason) {
        setMessage('info', msg.reason);
      }
      break;
    }
    case 'overlay': {
      addOverlay(msg.kind, msg.points, msg.source);
      break;
    }
    case 'status': {
      setMessage(msg.level, msg.text, msg.level === 'progress' && Boolean(attached));
      break;
    }
  }
});

renderState();
vscode.postMessage({ type: 'ready' });
