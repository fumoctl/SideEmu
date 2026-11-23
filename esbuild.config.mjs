import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const sharedOptions = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const extensionContext = await esbuild.context({
  ...sharedOptions,
  entryPoints: ['src/extension.ts'],
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode'],
});

const webviewContext = await esbuild.context({
  ...sharedOptions,
  entryPoints: ['src/webview/main.ts'],
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  outfile: 'dist/webview.js',
});

if (watch) {
  await Promise.all([extensionContext.watch(), webviewContext.watch()]);
  console.log('[esbuild] watching for changes...');
} else {
  await Promise.all([extensionContext.rebuild(), webviewContext.rebuild()]);
  await Promise.all([extensionContext.dispose(), webviewContext.dispose()]);
}
