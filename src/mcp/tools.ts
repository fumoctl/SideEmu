import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DeviceManager, ScreenElement } from '../devices/deviceManager';
import { NIX_FLAKE_GUIDE_MD, NIX_FLAKE_GUIDE_URI } from '../docs/nixFlakeGuide';

export interface McpUiBridge {
  focus(): Promise<void>;
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

function flattenElements(elements: ScreenElement[]): ScreenElement[] {
  const out: ScreenElement[] = [];
  const walk = (list: ScreenElement[]) => {
    for (const el of list) {
      out.push(el);
      if (el.children && el.children.length > 0) {
        walk(el.children);
      }
    }
  };
  walk(elements);
  return out;
}

function matchByRef(elements: ScreenElement[], refQuery: string): ScreenElement | undefined {
  const normalized = refQuery.startsWith('@') ? refQuery : `@${refQuery}`;
  const bare = refQuery.replace(/^@/, '');
  return flattenElements(elements).find(
    (el) => el.ref === refQuery || el.ref === normalized || el.ref === bare,
  );
}

function matchByText(elements: ScreenElement[], query: string): ScreenElement | undefined {
  const q = query.trim().toLowerCase();
  if (!q) {
    return undefined;
  }
  const all = flattenElements(elements);
  const candidates = (el: ScreenElement) =>
    [el.label, el.text, el.name, el.value, el.identifier, el.placeholder]
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim().toLowerCase());

  const exact = all.find((el) => candidates(el).some((v) => v === q));
  if (exact) {
    return exact;
  }
  return all.find((el) => candidates(el).some((v) => v.includes(q)));
}

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
        'Return a compact accessibility tree snapshot (mobilecli snapshot) for semantic UI navigation on Android and iOS.',
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
        'Tap on the device screen by (x, y) coordinates, element text/label, or @ref from get_ui_elements, and show a live ripple overlay in the sidebar.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        x: z.number().optional().describe('X coordinate in device screen units.'),
        y: z.number().optional().describe('Y coordinate in device screen units.'),
        text: z
          .string()
          .optional()
          .describe('Match an element by label/text/name/identifier and tap its center.'),
        ref: z
          .string()
          .optional()
          .describe('Match an element ref (e.g. "@e5") from get_ui_elements and tap its center.'),
      },
    },
    async ({ deviceId, x, y, text, ref }) => {
      try {
        const hasX = x !== undefined;
        const hasY = y !== undefined;
        if (hasX !== hasY) {
          throw new Error('Provide both x and y when tapping by coordinates.');
        }
        const modes = Number(hasX && hasY) + Number(text !== undefined) + Number(ref !== undefined);
        if (modes !== 1) {
          throw new Error('Provide exactly one of (x and y), text, or ref.');
        }

        const id = dm.resolveTargetDeviceId(deviceId);
        if (hasX && hasY) {
          const tx = Math.round(x!);
          const ty = Math.round(y!);
          await dm.tap(id, tx, ty, 'agent');
          return {
            content: [{ type: 'text', text: `Tapped (${tx}, ${ty}) on ${id}.` }],
          };
        }

        const elements = await dm.uiElements(id, false);
        const target = ref ? matchByRef(elements, ref) : matchByText(elements, text!);
        if (!target) {
          throw new Error(
            ref
              ? `No UI element found with ref "${ref}".`
              : `No UI element found matching "${text}".`,
          );
        }

        const cx = Math.round(target.rect.x + target.rect.width / 2);
        const cy = Math.round(target.rect.y + target.rect.height / 2);
        await dm.tap(id, cx, cy, 'agent');
        return {
          content: [
            {
              type: 'text',
              text: `Tapped ${target.ref ?? target.type} at (${cx}, ${cy}) on ${id}.`,
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
        'Perform a swipe gesture by coordinates or direction (up/down/left/right) and show a live trail overlay in the sidebar.',
      inputSchema: {
        deviceId: z.string().optional().describe('Target device ID; defaults to active device.'),
        x1: z.number().optional().describe('Starting X coordinate.'),
        y1: z.number().optional().describe('Starting Y coordinate.'),
        x2: z.number().optional().describe('Ending X coordinate.'),
        y2: z.number().optional().describe('Ending Y coordinate.'),
        direction: z
          .enum(['up', 'down', 'left', 'right'])
          .optional()
          .describe('Swipe direction around the screen center (alternative to x1,y1,x2,y2).'),
        durationMs: z
          .number()
          .int()
          .min(50)
          .max(5000)
          .optional()
          .describe('Optional swipe duration in milliseconds.'),
      },
    },
    async ({ deviceId, x1, y1, x2, y2, direction, durationMs }) => {
      try {
        const coordCount = [x1, y1, x2, y2].filter((v) => v !== undefined).length;
        const hasCoords = coordCount === 4;
        if (coordCount !== 0 && !hasCoords) {
          throw new Error('Provide all four coordinates (x1, y1, x2, y2) when swiping by coordinates.');
        }
        if (Number(hasCoords) + Number(direction !== undefined) !== 1) {
          throw new Error('Provide either (x1, y1, x2, y2) or direction.');
        }

        const id = dm.resolveTargetDeviceId(deviceId);
        let sx1: number;
        let sy1: number;
        let sx2: number;
        let sy2: number;

        if (hasCoords) {
          sx1 = Math.round(x1!);
          sy1 = Math.round(y1!);
          sx2 = Math.round(x2!);
          sy2 = Math.round(y2!);
        } else {
          const size = await dm.screenSize(id);
          const cx = size.width / 2;
          const cy = size.height / 2;
          const dx = size.width * 0.3;
          const dy = size.height * 0.3;
          switch (direction!) {
            case 'up':
              sx1 = Math.round(cx);
              sy1 = Math.round(cy + dy);
              sx2 = Math.round(cx);
              sy2 = Math.round(cy - dy);
              break;
            case 'down':
              sx1 = Math.round(cx);
              sy1 = Math.round(cy - dy);
              sx2 = Math.round(cx);
              sy2 = Math.round(cy + dy);
              break;
            case 'left':
              sx1 = Math.round(cx + dx);
              sy1 = Math.round(cy);
              sx2 = Math.round(cx - dx);
              sy2 = Math.round(cy);
              break;
            case 'right':
              sx1 = Math.round(cx - dx);
              sy1 = Math.round(cy);
              sx2 = Math.round(cx + dx);
              sy2 = Math.round(cy);
              break;
          }
        }

        await dm.swipe(id, sx1, sy1, sx2, sy2, durationMs, 'agent');
        return {
          content: [
            {
              type: 'text',
              text: `Swiped (${sx1}, ${sy1}) -> (${sx2}, ${sy2}) on ${id}.`,
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
        key: z.enum([
          'HOME',
          'POWER',
          'VOLUME_UP',
          'VOLUME_DOWN',
          'ENTER',
          'BACKSPACE',
          'BACK',
          'APP_SWITCH',
        ]),
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
