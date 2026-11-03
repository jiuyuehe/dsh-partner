import { build } from 'esbuild'

const pluginId = '@lemoncat7/dsh-partner'

// Keep Markdown parsing self-contained when deploying into a host-managed profile.
await build({ entryPoints: ['src/channels/direct/message-format.ts'], outfile: 'lib/channels/direct/message-format.js', bundle: true, format: 'esm', platform: 'node', target: 'es2022', sourcemap: true })

await build({ entryPoints: ['src/pendant/renderer.ts'], outfile: 'lib/pendant-renderer.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true })

// Versioned native chunk on both Web and Desktop. Keep the legacy ESM asset
// above for already-open clients; build all chunks before stamping client.js.
await build({
  entryPoints: ['src/pendant/renderer.ts'], outfile: 'lib/client.pendant.js',
  bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', minify: true,
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, chunk: 'client.pendant.js', factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
})

await build({
  entryPoints: ['src/client.tsx'],
  minifySyntax: true,
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  external: [
    'react',
    'react/jsx-runtime',
    '@deepseek-ai/dsh-api-session-controller/client',
    '@deepseek-ai/dsh-api-remotes/client',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  loader: { '.css': 'text' },
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
})
