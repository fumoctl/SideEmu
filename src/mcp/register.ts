import * as vscode from 'vscode';
import { log } from '../log';
import { McpHost } from './host';

export function registerMcpProvider(host: McpHost, version: string): vscode.Disposable {
  try {
    const lmAny = vscode.lm as unknown as {
      registerMcpServerDefinitionProvider?: (
        id: string,
        provider: {
          onDidChangeMcpServerDefinitions?: vscode.Event<void>;
          provideMcpServerDefinitions: () => unknown[];
        },
      ) => vscode.Disposable;
    };
    const DefCtor = (vscode as unknown as {
      McpHttpServerDefinition?: new (
        label: string,
        uri: vscode.Uri,
        headers?: Record<string, string>,
        version?: string,
      ) => unknown;
    }).McpHttpServerDefinition;

    if (
      typeof lmAny?.registerMcpServerDefinitionProvider === 'function' &&
      typeof DefCtor === 'function'
    ) {
      return lmAny.registerMcpServerDefinitionProvider('sidemu.mcp', {
        onDidChangeMcpServerDefinitions: host.onDidChange,
        provideMcpServerDefinitions: () =>
          host.url ? [new DefCtor('Sidemu', vscode.Uri.parse(host.url), {}, version)] : [],
      });
    }
  } catch (err) {
    log.warn(`Could not register MCP server definition provider: ${String(err)}`);
  }

  return new vscode.Disposable(() => {});
}

export async function copyMcpConfigCommand(host: McpHost): Promise<void> {
  const url = host.url ?? (await host.start());

  const choice = await vscode.window.showQuickPick(
    [
      {
        label: 'VS Code / VSCodium (.vscode/mcp.json)',
        detail: url,
        payload: {
          servers: {
            sidemu: {
              type: 'http',
              url,
            },
          },
        },
      },
      {
        label: 'Antigravity (~/.gemini/config/mcp_config.json)',
        detail: url,
        payload: {
          mcpServers: {
            sidemu: {
              serverUrl: url,
            },
          },
        },
      },
      {
        label: 'Generic mcpServers (Cursor / Claude / etc.)',
        detail: url,
        payload: {
          mcpServers: {
            sidemu: {
              type: 'http',
              url,
            },
          },
        },
      },
    ],
    {
      placeHolder: `Select MCP config snippet format (${url})`,
    },
  );

  if (!choice) {
    return;
  }

  await vscode.env.clipboard.writeText(JSON.stringify(choice.payload, null, 2));
  void vscode.window.showInformationMessage(`Copied Sidemu MCP config (${url}) to clipboard.`);
}
