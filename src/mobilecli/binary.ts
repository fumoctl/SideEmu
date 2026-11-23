import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';

export function resolveMobilecliPath(ctx: vscode.ExtensionContext): string {
  const override = vscode.workspace
    .getConfiguration('sidemu')
    .get<string>('mobilecliPath', '')
    .trim();
  const binName = process.platform === 'win32' ? 'mobilecli.exe' : 'mobilecli';
  const resolved = override || path.join(ctx.extensionPath, 'bin', binName);

  if (!fs.existsSync(resolved)) {
    throw new Error(
      `mobilecli binary not found at "${resolved}". Run "npm run fetch:mobilecli" or set "sidemu.mobilecliPath".`,
    );
  }
  return resolved;
}

export function ensureExecutable(filePath: string): void {
  if (process.platform === 'win32') {
    return;
  }
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {
    // Ignore read-only filesystem errors
  }
}
