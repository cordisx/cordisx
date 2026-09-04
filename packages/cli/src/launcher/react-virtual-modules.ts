import type { Metafile, Plugin } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import path from 'node:path'

export const CORDISX_CONTRACTS_MODULE = 'cordisx/contracts'
export const CORDISX_REACT_MODULE = 'cordisx/react'
export const CORDISX_REACT_JSX_RUNTIME_MODULE = 'cordisx/react/jsx-runtime'
export const CORDISX_REACT_JSX_DEV_RUNTIME_MODULE = 'cordisx/react/jsx-dev-runtime'
export const CORDISX_UI_MODULE = 'cordisx/ui'

const REACT_EXPORTS = [
  'Activity',
  'Children',
  'Component',
  'Fragment',
  'Profiler',
  'PureComponent',
  'StrictMode',
  'Suspense',
  'act',
  'cache',
  'cacheSignal',
  'captureOwnerStack',
  'cloneElement',
  'createContext',
  'createElement',
  'createRef',
  'forwardRef',
  'isValidElement',
  'lazy',
  'memo',
  'startTransition',
  'use',
  'useActionState',
  'useCallback',
  'useContext',
  'useDebugValue',
  'useDeferredValue',
  'useEffect',
  'useEffectEvent',
  'useId',
  'useImperativeHandle',
  'useInsertionEffect',
  'useLayoutEffect',
  'useMemo',
  'useOptimistic',
  'useReducer',
  'useRef',
  'useState',
  'useSyncExternalStore',
  'useTransition',
  'version',
] as const

const UI_EXPORTS = ['Button', 'Card', 'EmptyState', 'Heading', 'Icon', 'MarkdownViewer', 'Select', 'SelectionRail', 'Stack', 'Text'] as const

export const CONTRACTS_MODULE_PATH = fileURLToPath(new URL(
  import.meta.url.endsWith('.ts') ? '../contracts.ts' : '../contracts.js',
  import.meta.url,
))

function runtimePrelude(): string {
  return `const runtime = globalThis.__cordisxSharedReactRuntime;
if (runtime === undefined) throw new Error('CordisX shared React runtime is unavailable');`
}

function reactModule(): string {
  return `${runtimePrelude()}
const React = runtime.React;
export default React;
export const defineReactPage = runtime.defineReactPage;
${REACT_EXPORTS.map(name => `export const ${name} = React.${name};`).join('\n')}`
}

function jsxRuntimeModule(development: boolean): string {
  const source = development ? 'jsxDevRuntime' : 'jsxRuntime'
  return `${runtimePrelude()}
const jsxRuntime = runtime.${source};
export const Fragment = jsxRuntime.Fragment;
${development
    ? 'export const jsxDEV = jsxRuntime.jsxDEV;'
    : 'export const jsx = jsxRuntime.jsx;\nexport const jsxs = jsxRuntime.jsxs;'}`
}

function peerDomModule(client: boolean): string {
  const names = client ? ['createRoot', 'hydrateRoot', 'version']
    : ['createPortal', 'flushSync', 'prefetchDNS', 'preconnect', 'preinit', 'preinitModule', 'preload', 'preloadModule', 'requestFormReset', 'useFormState', 'useFormStatus', 'version']
  return `${runtimePrelude()}
const peer = runtime.${client ? 'reactDomClient' : 'reactDom'};
export default peer;
${names.map(name => `export const ${name} = peer.${name};`).join('\n')}`
}

function uiModule(): string {
  return `${runtimePrelude()}
${UI_EXPORTS.map(name => `export const ${name} = runtime.ui.${name};`).join('\n')}`
}

/** Shared source for both the packaged builder and Vite's plugin modules. */
export function cordisXSharedModuleSource(id: string): string {
  if (id === 'peer:react-dom') return peerDomModule(false)
  if (id === 'peer:react-dom/client') return peerDomModule(true)
  if (id === CORDISX_REACT_MODULE) return reactModule()
  if (id === CORDISX_REACT_JSX_RUNTIME_MODULE) return jsxRuntimeModule(false)
  if (id === CORDISX_REACT_JSX_DEV_RUNTIME_MODULE) return jsxRuntimeModule(true)
  if (id === CORDISX_UI_MODULE) return uiModule()
  throw new Error(`unsupported CordisX virtual module: ${id}`)
}

/** Resolve public plugin authoring modules against this exact Host generation. */
export function cordisXReactVirtualModules(entry: string): Plugin {
  let pluginRoot = path.dirname(path.resolve(entry))
  while (!existsSync(path.join(pluginRoot, 'package.json')) && path.dirname(pluginRoot) !== pluginRoot) pluginRoot = path.dirname(pluginRoot)

  return {
    name: 'cordisx-shared-react',
    setup(build): void {
      // Third-party components declare React as a peer. Reuse the Host singleton
      // for those peers while retaining the direct-plugin import restriction.
      build.onResolve({ filter: /^(react(\/jsx-(dev-)?runtime)?|react-dom(\/client)?)$/ }, args => {
        const relative = path.relative(pluginRoot, args.importer).replaceAll('\\', '/')
        if (!relative.startsWith('../') && !relative.split('/').includes('node_modules')) return
        if (!/(?:^|\/)node_modules\//u.test(args.importer.replaceAll('\\', '/'))) return
        return { path: args.path.startsWith('react-dom') ? `peer:${args.path}` : `cordisx/${args.path}`, namespace: 'cordisx-shared-react' }
      })
      build.onResolve({ filter: /^cordisx\/contracts$/ }, () => ({ path: CONTRACTS_MODULE_PATH }))
      build.onResolve({ filter: /^cordisx\/(react(\/jsx-(dev-)?runtime)?|ui)$/ }, args => ({
        path: args.path,
        namespace: 'cordisx-shared-react',
      }))
      build.onLoad({ filter: /.*/, namespace: 'cordisx-shared-react' }, args => {
        return { contents: cordisXSharedModuleSource(args.path), loader: 'js' }
      })
    },
  }
}

const PRIVATE_RENDERER_DEPENDENCY = /(?:^|\/)node_modules\/(?:react(?:-dom)?|tdesign-(?:react|icons-react))(?:\/|$)/u

/** A plugin must use the Host modules; bundling another renderer runtime is an error. */
export function assertNoPrivateReactBundle(metafile: Metafile, label: string): void {
  assertNoPrivateReactModules(Object.keys(metafile.inputs), label)
}

export function assertNoPrivateReactModules(inputs: readonly string[], label: string): void {
  const dependency = inputs
    .map(input => input.replaceAll('\\', '/'))
    .find(input => PRIVATE_RENDERER_DEPENDENCY.test(input))
  if (dependency !== undefined) {
    throw new Error(`${label} must import React and UI components from cordisx/react and cordisx/ui`)
  }
}
