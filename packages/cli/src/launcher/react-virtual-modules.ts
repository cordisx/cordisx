import type { Metafile, Plugin } from 'esbuild'
import { fileURLToPath } from 'node:url'

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

const CONTRACTS_MODULE_PATH = fileURLToPath(new URL(
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

function uiModule(): string {
  return `${runtimePrelude()}
${UI_EXPORTS.map(name => `export const ${name} = runtime.ui.${name};`).join('\n')}`
}

/** Resolve public plugin authoring modules against this exact Host generation. */
export function cordisXReactVirtualModules(): Plugin {
  return {
    name: 'cordisx-shared-react',
    setup(build): void {
      build.onResolve({ filter: /^cordisx\/contracts$/ }, () => ({ path: CONTRACTS_MODULE_PATH }))
      build.onResolve({ filter: /^cordisx\/(react(\/jsx-(dev-)?runtime)?|ui)$/ }, args => ({
        path: args.path,
        namespace: 'cordisx-shared-react',
      }))
      build.onLoad({ filter: /.*/, namespace: 'cordisx-shared-react' }, args => {
        if (args.path === CORDISX_REACT_MODULE) return { contents: reactModule(), loader: 'js' }
        if (args.path === CORDISX_REACT_JSX_RUNTIME_MODULE) return { contents: jsxRuntimeModule(false), loader: 'js' }
        if (args.path === CORDISX_REACT_JSX_DEV_RUNTIME_MODULE) return { contents: jsxRuntimeModule(true), loader: 'js' }
        if (args.path === CORDISX_UI_MODULE) return { contents: uiModule(), loader: 'js' }
        throw new Error(`unsupported CordisX virtual module: ${args.path}`)
      })
    },
  }
}

const PRIVATE_RENDERER_DEPENDENCY = /(?:^|\/)node_modules\/(?:react(?:-dom)?|tdesign-(?:react|icons-react))(?:\/|$)/u

/** A plugin must use the Host modules; bundling another renderer runtime is an error. */
export function assertNoPrivateReactBundle(metafile: Metafile, label: string): void {
  const dependency = Object.keys(metafile.inputs)
    .map(input => input.replaceAll('\\', '/'))
    .find(input => PRIVATE_RENDERER_DEPENDENCY.test(input))
  if (dependency !== undefined) {
    throw new Error(`${label} must import React and UI components from cordisx/react and cordisx/ui`)
  }
}
