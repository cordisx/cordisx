export const SHARED_MODULES = new Set([
  'cordisx/react',
  'cordisx/react/jsx-runtime',
  'cordisx/react/jsx-dev-runtime',
  'cordisx/ui',
])

export const COMMONJS_INTEROP_LEAVES = [
  'classnames',
  'dayjs',
  'debug',
  'extend',
  'hoist-non-react-statics',
  'prop-types',
  'raf',
  'react-fast-compare',
  'react-is',
  'style-to-js',
  'use-sync-external-store/shim',
  'use-sync-external-store/shim/index.js',
] as const

export const SHARED_REACT_INTEROP_LEAVES = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
] as const

export const VITE_CLIENT_DISPOSER_SOURCE = `
const __cordisxDisposeViteHmr = async () => {
  for (const id of new Set([...sheetsMap.keys(), ...linkSheetsMap.keys()])) removeStyle(id);
  willUnload = true;
  await transport.connect().catch(() => undefined);
  await transport.disconnect();
  if (globalThis.__cordisxViteHmrDispose === __cordisxDisposeViteHmr) delete globalThis.__cordisxViteHmrDispose;
};
globalThis.__cordisxViteHmrDispose = __cordisxDisposeViteHmr;
`
