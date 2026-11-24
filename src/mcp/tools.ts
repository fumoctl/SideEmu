import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DeviceManager } from '../devices/deviceManager';
import { NIX_FLAKE_GUIDE_MD, NIX_FLAKE_GUIDE_URI } from '../docs/nixFlakeGuide';

export interface McpUiBridge {
  focus(): Promise<void>;
}

type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: 'image/jpeg' };

const PRESS_KEY_ENUM = z.enum([
  'HOME',
  'POWER',
  'VOLUME_UP',
  'VOLUME_DOWN',
  'ENTER',
  'BACKSPACE',
  'BACK',
  'APP_SWITCH',
]);

const ORIENTATION_ENUM = z.enum(['portrait', 'landscape']);
const SWIPE_DIRECTION_ENUM = z.enum(['up', 'down', 'left', 'right']);

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

async function resolveTargetPoint(
  dm: DeviceManager,
  deviceId: string,
  opts: { x?: number; y?: number; ref?: string; text?: string; full?: boolean },
  label = 'target',
): Promise<{ x: number; y: number; desc: string }> {
  const hasX = opts.x !== undefined;
  const hasY = opts.y !== undefined;
  if (hasX !== hasY) {
    throw new Error(`Provide both x and y coordinates for ${label}.`);
  }
  const modes =
    Number(hasX && hasY) + Number(opts.ref !== undefined) + Number(opts.text !== undefined);
  if (modes !== 1) {
    throw new Error(`Provide exactly one of (x and y), ref, or text for ${label}.`);
  }
  if (hasX && hasY) {
    const rx = Math.round(opts.x!);
    const ry = Math.round(opts.y!);
    return { x: rx, y: ry, desc: `(${rx}, ${ry})` };
  }
  const target = await dm.resolveElement(deviceId, {
    ref: opts.ref,
    text: opts.text,
    full: opts.full,
  });
  const cx = Math.round(target.rect.x + target.rect.width / 2);
  const cy = Math.round(target.rect.y + target.rect.height / 2);
  const name = target.ref ? `${target.ref} [${target.type}]` : `[${target.type}]`;
  return { x: cx, y: cy, desc: `${name} at (${cx}, ${cy})` };
}

async function resolveSwipeCoords(
  dm: DeviceManager,
  deviceId: string,
  opts: {
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
    direction?: 'up' | 'down' | 'left' | 'right';
    ref?: string;
    text?: string;
    full?: boolean;
  },
): Promise<{ x1: number; y1: number; x2: number; y2: number }> {
  const coordCount = [opts.x1, opts.y1, opts.x2, opts.y2].filter((v) => v !== undefined).length;
  const hasCoords = coordCount === 4;
  if (coordCount !== 0 && !hasCoords) {
    throw new Error('Provide all four coordinates (x1, y1, x2, y2) when swiping by coordinates.');
  }
  if (Number(hasCoords) + Number(opts.direction !== undefined) !== 1) {
    throw new Error('Provide either (x1, y1, x2, y2) or direction.');
  }

  if (hasCoords) {
    return {
      x1: Math.round(opts.x1!),
      y1: Math.round(opts.y1!),
      x2: Math.round(opts.x2!),
      y2: Math.round(opts.y2!),
    };
  }

  let box: { x: number; y: number; width: number; height: number };
  if (opts.ref !== undefined || opts.text !== undefined) {
    if (opts.ref !== undefined && opts.text !== undefined) {
      throw new Error('Provide at most one of ref or text when swiping a container.');
    }
    const el = await dm.resolveElement(deviceId, {
      ref: opts.ref,
      text: opts.text,
      full: opts.full,
    });
    box = el.rect;
  } else {
    const size = await dm.screenSize(deviceId);
    box = { x: 0, y: 0, width: size.width, height: size.height };
  }

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = box.width * 0.3;
  const dy = box.height * 0.3;
  switch (opts.direction!) {
    case 'up':
      return {
        x1: Math.round(cx),
        y1: Math.round(cy + dy),
        x2: Math.round(cx),
        y2: Math.round(cy - dy),
      };
    case 'down':
      return {
        x1: Math.round(cx),
        y1: Math.round(cy - dy),
        x2: Math.round(cx),
        y2: Math.round(cy + dy),
      };
    case 'left':
      return {
        x1: Math.round(cx + dx),
        y1: Math.round(cy),
        x2: Math.round(cx - dx),
        y2: Math.round(cy),
      };
    case 'right':
      return {
        x1: Math.round(cx - dx),
        y1: Math.round(cy),
        x2: Math.round(cx + dx),
        y2: Math.round(cy),
      };
  }
}

const BATCH_STEP_SCHEMA = z.object({
  action: z
    .enum([
      'tap',
      'double_tap',
      'long_press',
      'swipe',
      'drag',
      'type_text',
      'press_key',
      'open_url',
      'launch_app',
      'terminate_app',
      'clear_app_data',
      'set_orientation',
      'wait',
      'get_ui_elements',
      'get_screenshot',
    ])
    .describe('Step action to run.'),
  x: z.number().optional().describe('X coordinate (tap / double_tap / long_press).'),
  y: z.number().optional().describe('Y coordinate (tap / double_tap / long_press).'),
  ref: z
    .string()
    .optional()
    .describe('Element @ref from get_ui_elements (tap / double_tap / long_press / directional swipe).'),
  text: z
    .string()
    .optional()
    .describe('Text to type (for type_text) or element label/text to match (for tap / double_tap / long_press / swipe).'),
  full: z.boolean().optional().describe('Include system UI / keyboard in UI queries.'),
  x1: z.number().optional().describe('Start X coordinate (swipe / drag).'),
  y1: z.number().optional().describe('Start Y coordinate (swipe / drag).'),
  x2: z.number().optional().describe('End X coordinate (swipe / drag).'),
  y2: z.number().optional().describe('End Y coordinate (swipe / drag).'),
  fromRef: z.string().optional().describe('Drag start element @ref.'),
  fromText: z.string().optional().describe('Drag start element label/text.'),
  toRef: z.string().optional().describe('Drag end element @ref.'),
  toText: z.string().optional().describe('Drag end element label/text.'),
  direction: SWIPE_DIRECTION_ENUM.optional().describe('Swipe direction (up/down/left/right).'),
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(30000)
    .optional()
    .describe('Duration in ms (long_press, swipe, drag, or wait).'),
  holdMs: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .optional()
    .describe('Initial press-and-hold duration in ms before dragging (default 500).'),
  intervalMs: z
    .number()
    .int()
    .min(10)
    .max(400)
    .optional()
    .describe('Delay in ms between taps in double_tap (default 60).'),
  submit: z.boolean().optional().describe('Press ENTER after type_text.'),
  key: PRESS_KEY_ENUM.optional().describe('Hardware or navigation key for press_key.'),
  url: z.string().optional().describe('URL or deep link for open_url.'),
  bundleId: z
    .string()
    .optional()
    .describe('Android package name or iOS bundle ID (launch_app / terminate_app / clear_app_data).'),
  activity: z.string().optional().describe('Optional Android activity for launch_app.'),
  locales: z.array(z.string()).optional().describe('Optional locale list for launch_app.'),
  orientation: ORIENTATION_ENUM.optional().describe('Target orientation for set_orientation.'),
  maxSize: z
    .number()
    .int()
    .min(64)
    .max(2048)
    .optional()
    .describe('Max screenshot dimension for get_screenshot (default 1024).'),
  quality: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('JPEG quality for get_screenshot (default 70).'),
});

export function registerTools(server: McpServer, dm: DeviceManager, ui: McpUiBridge): void {
  server.registerTool(
    'list_devices',
    {
      title: 'List Devices',
      description:
        'List online/offline Android emulators, iOS simulators (macOS), physical devices, and configured Nix flake launch targets.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        await dm.refresh({ resolveEnvironment: true });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  activeDeviceId: dm.activeId,
                  devices: dm.devices,
                  launchTargets: dm.launchTargets,
                  toolchain: dm.toolchain,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'boot_device',
    {
      title: 'Boot Device',
      description:
        'Focus the Sidemu sidebar, boot an Android AVD, iOS Simulator, or Nix launch target headlessly, wait until ready, attach the stream, and return its device ID.',
      inputSchema: {
        deviceId: z
          .string()
          .optional()
          .describe('Offline device ID or launch target ID (e.g. "launch:flake").'),
      },
    },
    async ({ deviceId }) => {
      try {
        await dm.refresh({ resolveEnvironment: true });
        let targetId = deviceId?.trim();

        if (!targetId) {
          if (dm.launchTargets.length === 1) {
            targetId = dm.launchTargets[0]!.id;
          } else {
            const bootable = [
              ...dm.launchTargets.map((t) => t.id),
              ...dm.devices
                .filter((d) => d.state === 'offline' && d.type !== 'real')
                .map((d) => d.id),
            ];
            throw new Error(
              bootable.length > 0
                ? `Specify deviceId to boot. Available targets: ${bootable.join(', ')}`
                : 'No offline emulators, simulators, or Nix launch targets are available to boot.',
            );
          }
        }

        const bootedId = await dm.boot(targetId, () => ui.focus());
        return {
          content: [
            {
              type: 'text',
              text: `Booted ${bootedId}; streaming in the Sidemu sidebar.`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'shutdown_device',
    {
      title: 'Shutdown Device',
      description: 'Shut down the active or specified running emulator/simulator and detach its stream.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
      },
    },
    async ({ deviceId }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        await dm.shutdown(id);
        return {
          content: [{ type: 'text', text: `Shut down ${id}.` }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'install_app',
    {
      title: 'Install App',
      description:
        'Install an Android APK or iOS .app / .ipa onto the active or specified device.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        path: z
          .string()
          .describe('Path to the .apk, .app, or .ipa file (absolute or relative to workspace root).'),
        forceResign: z
          .boolean()
          .optional()
          .describe('Re-sign an .ipa before installing onto a physical iOS device.'),
        provisioningProfile: z
          .string()
          .optional()
          .describe('Optional provisioning profile path when forceResign is true.'),
        signingIdentity: z
          .string()
          .optional()
          .describe('Optional code-signing identity when forceResign is true.'),
      },
    },
    async ({ deviceId, path: appPath, forceResign, provisioningProfile, signingIdentity }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        const res = await dm.installApp(id, {
          path: appPath,
          forceResign,
          provisioningProfile,
          signingIdentity,
        });
        const meta = res.app?.bundleId
          ? ` (${res.app.name ? `${res.app.name}, ` : ''}${res.app.bundleId}${res.app.version ? ` v${res.app.version}` : ''})`
          : '';
        return {
          content: [{ type: 'text', text: `${res.message}${meta}` }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'uninstall_app',
    {
      title: 'Uninstall App',
      description:
        'Uninstall an app by Android package name or iOS bundle ID from the active or specified device.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        bundleId: z
          .string()
          .describe('Android package name (e.g. "com.example.app") or iOS bundle ID.'),
      },
    },
    async ({ deviceId, bundleId }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        await dm.uninstallApp(id, bundleId);
        return {
          content: [{ type: 'text', text: `Uninstalled "${bundleId}" from ${id}.` }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'launch_app',
    {
      title: 'Launch App',
      description:
        'Launch an installed app by Android package name or iOS bundle ID on the active or specified device.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        bundleId: z
          .string()
          .describe('Android package name (e.g. "com.android.settings") or iOS bundle ID.'),
        activity: z
          .string()
          .optional()
          .describe('Optional Android activity name to start (Android only).'),
        locales: z
          .array(z.string())
          .optional()
          .describe('Optional preferred locale codes when launching.'),
      },
    },
    async ({ deviceId, bundleId, activity, locales }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        await dm.launchApp(id, { bundleId, activity, locales });
        return {
          content: [{ type: 'text', text: `Launched "${bundleId}" on ${id}.` }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'terminate_app',
    {
      title: 'Terminate App',
      description:
        'Force-stop / terminate a running app by Android package name or iOS bundle ID.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        bundleId: z
          .string()
          .describe('Android package name or iOS bundle ID to terminate.'),
      },
    },
    async ({ deviceId, bundleId }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        await dm.terminateApp(id, bundleId);
        return {
          content: [{ type: 'text', text: `Terminated "${bundleId}" on ${id}.` }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'clear_app_data',
    {
      title: 'Clear App Data',
      description:
        'Clear persisted app data and cache for an Android package name or iOS bundle ID.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        bundleId: z
          .string()
          .describe('Android package name or iOS bundle ID whose data should be cleared.'),
      },
    },
    async ({ deviceId, bundleId }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        await dm.clearAppData(id, bundleId);
        return {
          content: [{ type: 'text', text: `Cleared app data for "${bundleId}" on ${id}.` }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_screenshot',
    {
      title: 'Get Screenshot',
      description:
        'Capture a downscaled JPEG screenshot from the active or specified device as an MCP image content block.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        maxSize: z
          .number()
          .int()
          .min(64)
          .max(2048)
          .default(1024)
          .describe('Maximum width or height in pixels (64-2048).'),
        quality: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(70)
          .describe('JPEG quality (1-100).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ deviceId, maxSize, quality }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        const [size, shot] = await Promise.all([
          dm.screenSize(id),
          dm.screenshot(id, { format: 'jpeg', maxSize, quality }),
        ]);
        return {
          content: [
            {
              type: 'image',
              data: shot.base64,
              mimeType: 'image/jpeg',
            },
            {
              type: 'text',
              text: `Screen coordinate space: ${size.width}x${size.height} (use these units for tap/swipe). Image is downscaled.`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_ui_elements',
    {
      title: 'Get UI Elements',
      description:
        'Return a compact accessibility tree snapshot with @eN element refs (cached for fast @ref interactions across tap, double_tap, long_press, drag, swipe, and batch_actions).',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        full: z
          .boolean()
          .optional()
          .describe('Include system elements such as on-screen keyboard and status bar.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ deviceId, full }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        const [size, text] = await Promise.all([
          dm.screenSize(id),
          dm.uiText(id, Boolean(full)),
        ]);
        return {
          content: [
            {
              type: 'text',
              text: `Screen coordinate space: ${size.width}x${size.height}\n\n${text || '(empty UI tree)'}`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'tap',
    {
      title: 'Tap',
      description:
        'Tap on the device screen by (x, y) coordinates, element @ref from get_ui_elements, or element text/label, and show a live ripple overlay in the sidebar.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        x: z.number().optional().describe('X coordinate in device screen units.'),
        y: z.number().optional().describe('Y coordinate in device screen units.'),
        ref: z
          .string()
          .optional()
          .describe('Element ref (e.g. "@e5") from get_ui_elements to tap at its center.'),
        text: z
          .string()
          .optional()
          .describe('Match an element by label/text/name/identifier and tap its center.'),
        full: z
          .boolean()
          .optional()
          .describe('Include keyboard and system UI when resolving text or uncached refs.'),
      },
    },
    async ({ deviceId, x, y, ref, text, full }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        const pt = await resolveTargetPoint(dm, id, { x, y, ref, text, full });
        await dm.tap(id, pt.x, pt.y, 'agent');
        return {
          content: [{ type: 'text', text: `Tapped ${pt.desc} on ${id}.` }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'double_tap',
    {
      title: 'Double Tap',
      description:
        'Double-tap on the device screen by (x, y) coordinates, element @ref, or element text/label, and show live ripple overlays in the sidebar.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        x: z.number().optional().describe('X coordinate in device screen units.'),
        y: z.number().optional().describe('Y coordinate in device screen units.'),
        ref: z
          .string()
          .optional()
          .describe('Element ref (e.g. "@e5") from get_ui_elements to double-tap.'),
        text: z
          .string()
          .optional()
          .describe('Match an element by label/text/name/identifier and double-tap its center.'),
        intervalMs: z
          .number()
          .int()
          .min(10)
          .max(400)
          .default(60)
          .describe('Delay between the two taps in milliseconds (10-400, default 60).'),
        full: z
          .boolean()
          .optional()
          .describe('Include keyboard and system UI when resolving text or uncached refs.'),
      },
    },
    async ({ deviceId, x, y, ref, text, intervalMs, full }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        const pt = await resolveTargetPoint(dm, id, { x, y, ref, text, full });
        await dm.doubleTap(id, pt.x, pt.y, intervalMs, 'agent');
        return {
          content: [{ type: 'text', text: `Double-tapped ${pt.desc} on ${id}.` }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'long_press',
    {
      title: 'Long Press',
      description:
        'Press and hold on the device screen by (x, y) coordinates, element @ref, or element text/label, and show a live hold overlay in the sidebar.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        x: z.number().optional().describe('X coordinate in device screen units.'),
        y: z.number().optional().describe('Y coordinate in device screen units.'),
        ref: z
          .string()
          .optional()
          .describe('Element ref (e.g. "@e5") from get_ui_elements to long-press.'),
        text: z
          .string()
          .optional()
          .describe('Match an element by label/text/name/identifier and long-press its center.'),
        durationMs: z
          .number()
          .int()
          .min(100)
          .max(10000)
          .default(600)
          .describe('Hold duration in milliseconds (100-10000, default 600).'),
        full: z
          .boolean()
          .optional()
          .describe('Include keyboard and system UI when resolving text or uncached refs.'),
      },
    },
    async ({ deviceId, x, y, ref, text, durationMs, full }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        const pt = await resolveTargetPoint(dm, id, { x, y, ref, text, full });
        await dm.longpress(id, pt.x, pt.y, durationMs, 'agent');
        return {
          content: [
            {
              type: 'text',
              text: `Long-pressed ${pt.desc} for ${durationMs}ms on ${id}.`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'swipe',
    {
      title: 'Swipe',
      description:
        'Perform a swipe/scroll gesture by coordinates or direction (optionally scoped to a container @ref or text) and show a live trail overlay in the sidebar.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        x1: z.number().optional().describe('Starting X coordinate.'),
        y1: z.number().optional().describe('Starting Y coordinate.'),
        x2: z.number().optional().describe('Ending X coordinate.'),
        y2: z.number().optional().describe('Ending Y coordinate.'),
        direction: SWIPE_DIRECTION_ENUM.optional().describe(
          'Swipe direction (up/down/left/right); alternative to x1,y1,x2,y2.',
        ),
        ref: z
          .string()
          .optional()
          .describe('Optional scrollable container @ref when using direction.'),
        text: z
          .string()
          .optional()
          .describe('Optional scrollable container label/text when using direction.'),
        durationMs: z
          .number()
          .int()
          .min(50)
          .max(5000)
          .optional()
          .describe('Optional swipe duration in milliseconds.'),
        full: z
          .boolean()
          .optional()
          .describe('Include keyboard and system UI when resolving container ref/text.'),
      },
    },
    async ({ deviceId, x1, y1, x2, y2, direction, ref, text, durationMs, full }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        const coords = await resolveSwipeCoords(dm, id, {
          x1,
          y1,
          x2,
          y2,
          direction,
          ref,
          text,
          full,
        });
        await dm.swipe(id, coords.x1, coords.y1, coords.x2, coords.y2, durationMs, 'agent');
        return {
          content: [
            {
              type: 'text',
              text: `Swiped (${coords.x1}, ${coords.y1}) -> (${coords.x2}, ${coords.y2}) on ${id}.`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'drag',
    {
      title: 'Drag',
      description:
        'Press, hold, and drag from a start point/element ((x1, y1), fromRef, or fromText) to an end point/element ((x2, y2), toRef, or toText), showing a live trail overlay.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        x1: z.number().optional().describe('Start X coordinate.'),
        y1: z.number().optional().describe('Start Y coordinate.'),
        fromRef: z.string().optional().describe('Start element @ref from get_ui_elements.'),
        fromText: z.string().optional().describe('Start element label/text/identifier.'),
        x2: z.number().optional().describe('End X coordinate.'),
        y2: z.number().optional().describe('End Y coordinate.'),
        toRef: z.string().optional().describe('Destination element @ref from get_ui_elements.'),
        toText: z.string().optional().describe('Destination element label/text/identifier.'),
        holdMs: z
          .number()
          .int()
          .min(0)
          .max(10000)
          .default(500)
          .describe('Initial hold duration in milliseconds before moving (default 500).'),
        durationMs: z
          .number()
          .int()
          .min(50)
          .max(10000)
          .default(500)
          .describe('Drag movement duration in milliseconds (default 500).'),
        full: z
          .boolean()
          .optional()
          .describe('Include keyboard and system UI when resolving text or uncached refs.'),
      },
    },
    async ({
      deviceId,
      x1,
      y1,
      fromRef,
      fromText,
      x2,
      y2,
      toRef,
      toText,
      holdMs,
      durationMs,
      full,
    }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        const start = await resolveTargetPoint(
          dm,
          id,
          { x: x1, y: y1, ref: fromRef, text: fromText, full },
          'drag start',
        );
        const end = await resolveTargetPoint(
          dm,
          id,
          { x: x2, y: y2, ref: toRef, text: toText, full },
          'drag end',
        );
        await dm.drag(id, start.x, start.y, end.x, end.y, { holdMs, durationMs }, 'agent');
        return {
          content: [
            {
              type: 'text',
              text: `Dragged ${start.desc} -> ${end.desc} on ${id}.`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'type_text',
    {
      title: 'Type Text',
      description: 'Type text into the currently focused field on the device.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        text: z.string().describe('Text to enter.'),
        submit: z.boolean().optional().describe('Press ENTER after typing.'),
      },
    },
    async ({ deviceId, text, submit }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        await dm.typeText(id, text);
        if (submit) {
          await dm.pressButton(id, 'ENTER');
        }
        return {
          content: [
            {
              type: 'text',
              text: `Typed ${text.length} character(s)${submit ? ' and pressed ENTER' : ''} on ${id}.`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'press_key',
    {
      title: 'Press Key',
      description:
        'Press a hardware or navigation button (HOME, POWER, VOLUME_UP, VOLUME_DOWN, ENTER, BACKSPACE, or Android-only BACK / APP_SWITCH).',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        key: PRESS_KEY_ENUM,
      },
    },
    async ({ deviceId, key }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        await dm.pressButton(id, key);
        return {
          content: [{ type: 'text', text: `Pressed ${key} on ${id}.` }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_orientation',
    {
      title: 'Get Orientation',
      description: 'Get the current screen orientation ("portrait" or "landscape") of the device.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ deviceId }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        const orientation = await dm.getOrientation(id);
        return {
          content: [{ type: 'text', text: `Orientation of ${id}: ${orientation}` }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'set_orientation',
    {
      title: 'Set Orientation',
      description: 'Switch the device screen orientation to "portrait" or "landscape".',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        orientation: ORIENTATION_ENUM.describe('Target orientation ("portrait" or "landscape").'),
      },
    },
    async ({ deviceId, orientation }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        await dm.setOrientation(id, orientation);
        return {
          content: [{ type: 'text', text: `Set orientation of ${id} to ${orientation}.` }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'start_screen_recording',
    {
      title: 'Start Screen Recording',
      description:
        'Start recording the device screen to an MP4 file on the host. Call stop_screen_recording to finalize the file.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        outputPath: z
          .string()
          .optional()
          .describe(
            'Output .mp4 path (absolute or relative to workspace root; defaults to sidemu-recording-<timestamp>.mp4).',
          ),
        timeLimitSec: z
          .number()
          .int()
          .min(1)
          .max(1800)
          .optional()
          .describe('Optional maximum recording duration in seconds.'),
        recordingId: z
          .string()
          .optional()
          .describe('Optional identifier to reference when stopping this recording.'),
      },
    },
    async ({ deviceId, outputPath, timeLimitSec, recordingId }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        const res = await dm.startScreenRecording(id, { outputPath, timeLimitSec, recordingId });
        return {
          content: [
            {
              type: 'text',
              text: `Started recording on ${id} (recordingId: ${res.recordingId}) -> ${res.output}`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'stop_screen_recording',
    {
      title: 'Stop Screen Recording',
      description:
        'Stop an in-progress screen recording (by recordingId, deviceId, or all active recordings) and finalize the MP4 file.',
      inputSchema: {
        deviceId: z
          .string()
          .optional()
          .describe('Optional device ID whose recording(s) should be stopped.'),
        recordingId: z
          .string()
          .optional()
          .describe('Optional recordingId returned by start_screen_recording.'),
      },
    },
    async ({ deviceId, recordingId }) => {
      try {
        const resolvedDevice = deviceId ? dm.resolveTargetDeviceId(deviceId) : undefined;
        const items = await dm.stopScreenRecording({ deviceId: resolvedDevice, recordingId });
        const summary = items
          .map((item) => {
            if (item.error) {
              return `Recording ${item.recordingId ?? 'unknown'} failed: ${item.error}`;
            }
            const meta = [
              item.duration ? `duration=${item.duration}` : '',
              item.frameCount ? `frames=${item.frameCount}` : '',
              item.endReason ? `reason=${item.endReason}` : '',
            ]
              .filter(Boolean)
              .join(', ');
            return `Saved recording ${item.recordingId ?? ''} -> ${item.output ?? '(unknown path)'}${meta ? ` (${meta})` : ''}`.trim();
          })
          .join('\n');
        return {
          content: [{ type: 'text', text: summary || 'Stopped screen recording.' }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'batch_actions',
    {
      title: 'Batch Actions',
      description:
        'Execute an ordered sequence of device interactions (tap, double_tap, long_press, swipe, drag, type_text, press_key, open_url, launch_app, terminate_app, clear_app_data, set_orientation, wait, get_ui_elements, get_screenshot) in a single MCP tool call.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        stopOnError: z
          .boolean()
          .default(true)
          .describe('Abort remaining steps when a step fails (default true).'),
        steps: z
          .array(BATCH_STEP_SCHEMA)
          .min(1)
          .max(50)
          .describe('Ordered list of steps to run (1-50).'),
      },
    },
    async ({ deviceId, stopOnError, steps }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        const logLines: string[] = [];
        const extraBlocks: ToolContentBlock[] = [];
        let hadError = false;

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i]!;
          const prefix = `${i + 1}. [${step.action}]`;
          try {
            switch (step.action) {
              case 'tap': {
                const pt = await resolveTargetPoint(dm, id, {
                  x: step.x,
                  y: step.y,
                  ref: step.ref,
                  text: step.text,
                  full: step.full,
                });
                await dm.tap(id, pt.x, pt.y, 'agent');
                logLines.push(`${prefix} Tapped ${pt.desc}`);
                break;
              }
              case 'double_tap': {
                const pt = await resolveTargetPoint(dm, id, {
                  x: step.x,
                  y: step.y,
                  ref: step.ref,
                  text: step.text,
                  full: step.full,
                });
                await dm.doubleTap(id, pt.x, pt.y, step.intervalMs ?? 60, 'agent');
                logLines.push(`${prefix} Double-tapped ${pt.desc}`);
                break;
              }
              case 'long_press': {
                const pt = await resolveTargetPoint(dm, id, {
                  x: step.x,
                  y: step.y,
                  ref: step.ref,
                  text: step.text,
                  full: step.full,
                });
                const dur = step.durationMs ?? 600;
                await dm.longpress(id, pt.x, pt.y, dur, 'agent');
                logLines.push(`${prefix} Long-pressed ${pt.desc} (${dur}ms)`);
                break;
              }
              case 'swipe': {
                const coords = await resolveSwipeCoords(dm, id, {
                  x1: step.x1,
                  y1: step.y1,
                  x2: step.x2,
                  y2: step.y2,
                  direction: step.direction,
                  ref: step.ref,
                  text: step.text,
                  full: step.full,
                });
                await dm.swipe(
                  id,
                  coords.x1,
                  coords.y1,
                  coords.x2,
                  coords.y2,
                  step.durationMs,
                  'agent',
                );
                logLines.push(
                  `${prefix} Swiped (${coords.x1}, ${coords.y1}) -> (${coords.x2}, ${coords.y2})`,
                );
                break;
              }
              case 'drag': {
                const start = await resolveTargetPoint(
                  dm,
                  id,
                  {
                    x: step.x1,
                    y: step.y1,
                    ref: step.fromRef,
                    text: step.fromText,
                    full: step.full,
                  },
                  'drag start',
                );
                const end = await resolveTargetPoint(
                  dm,
                  id,
                  { x: step.x2, y: step.y2, ref: step.toRef, text: step.toText, full: step.full },
                  'drag end',
                );
                await dm.drag(
                  id,
                  start.x,
                  start.y,
                  end.x,
                  end.y,
                  { holdMs: step.holdMs, durationMs: step.durationMs },
                  'agent',
                );
                logLines.push(`${prefix} Dragged ${start.desc} -> ${end.desc}`);
                break;
              }
              case 'type_text': {
                if (step.text === undefined) {
                  throw new Error('"text" is required for type_text.');
                }
                await dm.typeText(id, step.text);
                if (step.submit) {
                  await dm.pressButton(id, 'ENTER');
                }
                logLines.push(
                  `${prefix} Typed ${step.text.length} character(s)${step.submit ? ' + ENTER' : ''}`,
                );
                break;
              }
              case 'press_key': {
                if (!step.key) {
                  throw new Error('"key" is required for press_key.');
                }
                await dm.pressButton(id, step.key);
                logLines.push(`${prefix} Pressed ${step.key}`);
                break;
              }
              case 'open_url': {
                if (!step.url) {
                  throw new Error('"url" is required for open_url.');
                }
                await dm.openUrl(id, step.url);
                logLines.push(`${prefix} Opened "${step.url}"`);
                break;
              }
              case 'launch_app': {
                if (!step.bundleId) {
                  throw new Error('"bundleId" is required for launch_app.');
                }
                await dm.launchApp(id, {
                  bundleId: step.bundleId,
                  activity: step.activity,
                  locales: step.locales,
                });
                logLines.push(`${prefix} Launched "${step.bundleId}"`);
                break;
              }
              case 'terminate_app': {
                if (!step.bundleId) {
                  throw new Error('"bundleId" is required for terminate_app.');
                }
                await dm.terminateApp(id, step.bundleId);
                logLines.push(`${prefix} Terminated "${step.bundleId}"`);
                break;
              }
              case 'clear_app_data': {
                if (!step.bundleId) {
                  throw new Error('"bundleId" is required for clear_app_data.');
                }
                await dm.clearAppData(id, step.bundleId);
                logLines.push(`${prefix} Cleared app data for "${step.bundleId}"`);
                break;
              }
              case 'set_orientation': {
                if (!step.orientation) {
                  throw new Error('"orientation" is required for set_orientation.');
                }
                await dm.setOrientation(id, step.orientation);
                logLines.push(`${prefix} Set orientation to ${step.orientation}`);
                break;
              }
              case 'wait': {
                const ms = Math.max(0, Math.min(30_000, step.durationMs ?? 500));
                if (ms > 0) {
                  await new Promise((r) => setTimeout(r, ms));
                }
                logLines.push(`${prefix} Waited ${ms}ms`);
                break;
              }
              case 'get_ui_elements': {
                const [size, tree] = await Promise.all([
                  dm.screenSize(id),
                  dm.uiText(id, Boolean(step.full)),
                ]);
                logLines.push(`${prefix} Captured UI snapshot (${size.width}x${size.height})`);
                extraBlocks.push({
                  type: 'text',
                  text: `=== Step ${i + 1} UI Elements (${size.width}x${size.height}) ===\n${tree || '(empty UI tree)'}`,
                });
                break;
              }
              case 'get_screenshot': {
                const [size, shot] = await Promise.all([
                  dm.screenSize(id),
                  dm.screenshot(id, {
                    format: 'jpeg',
                    maxSize: step.maxSize ?? 1024,
                    quality: step.quality ?? 70,
                  }),
                ]);
                logLines.push(`${prefix} Captured screenshot (${size.width}x${size.height})`);
                extraBlocks.push({
                  type: 'image',
                  data: shot.base64,
                  mimeType: 'image/jpeg',
                });
                break;
              }
            }
          } catch (stepErr) {
            hadError = true;
            const msg = stepErr instanceof Error ? stepErr.message : String(stepErr);
            logLines.push(`${prefix} ERROR: ${msg}`);
            if (stopOnError) {
              break;
            }
          }
        }

        const content: ToolContentBlock[] = [
          {
            type: 'text',
            text: `Batch execution on ${id}:\n${logLines.join('\n')}`,
          },
          ...extraBlocks,
        ];
        return hadError ? { content, isError: true } : { content };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'open_url',
    {
      title: 'Open URL',
      description: 'Open a web URL or deep link on the active or specified device.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        url: z.string().describe('URL or deep link URI to open.'),
      },
    },
    async ({ deviceId, url }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        await dm.openUrl(id, url);
        return {
          content: [{ type: 'text', text: `Opened "${url}" on ${id}.` }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_crash_logs',
    {
      title: 'Get Crash Logs',
      description: 'Fetch recent crash reports for the active or specified device.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(3)
          .describe('Maximum number of recent crash reports to return (1-10).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ deviceId, limit }) => {
      try {
        const id = dm.resolveTargetDeviceId(deviceId);
        const reports = await dm.crashLogs(id, limit);
        if (reports.length === 0) {
          return {
            content: [{ type: 'text', text: `No crash reports found for ${id}.` }],
          };
        }
        const formatted = reports
          .map((r, idx) => {
            const header = `=== Crash #${idx + 1}: ${r.processName ?? 'unknown'} (${r.timestamp ?? 'unknown time'}) [${r.id}] ===`;
            const body =
              r.content.length > 8000
                ? `${r.content.slice(0, 8000)}\n...[truncated ${r.content.length - 8000} chars]`
                : r.content;
            return `${header}\n${body}`;
          })
          .join('\n\n');
        return {
          content: [{ type: 'text', text: formatted }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_nix_flake_guide',
    {
      title: 'Get Nix Flake Guide',
      description:
        'Return documentation and copy-pasteable flake.nix templates for structuring a Nix flake (with or without .envrc) so Sidemu detects Android SDK/ADB and boots headless emulators.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [{ type: 'text', text: NIX_FLAKE_GUIDE_MD }],
    }),
  );

  server.registerResource(
    'nix-flake-guide',
    NIX_FLAKE_GUIDE_URI,
    {
      title: 'Sidemu Nix Flake Guide',
      description:
        'How to structure a Nix flake.nix (with or without .envrc) to work with Sidemu Android emulator discovery and ADB.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'text/markdown',
          text: NIX_FLAKE_GUIDE_MD,
        },
      ],
    }),
  );

  server.registerPrompt(
    'setup_nix_flake',
    {
      title: 'Set Up Nix Flake for Sidemu',
      description:
        'Instructions and copy-pasteable flake.nix templates for structuring a workspace flake to work with Sidemu.',
    },
    async () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: NIX_FLAKE_GUIDE_MD,
          },
        },
      ],
    }),
  );
}
