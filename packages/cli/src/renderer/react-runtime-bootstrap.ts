import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as jsxRuntime from 'react/jsx-runtime'
import * as jsxDevRuntime from 'react/jsx-dev-runtime'

export interface PreparedReactRuntime {
  readonly React: typeof React
  readonly reactDom: typeof ReactDOM
  readonly reactDomClient: typeof ReactDOMClient
  readonly jsxRuntime: typeof jsxRuntime
  readonly jsxDevRuntime: typeof jsxDevRuntime
}

declare global {
  // eslint-disable-next-line no-var
  var __cordisxPreparedReactRuntime: PreparedReactRuntime | undefined
}

/** Publish only cycle-free React modules before the complete Host UI graph evaluates. */
export function prepareReactModules(): void {
  if (globalThis.__cordisxSharedReactRuntime !== undefined || globalThis.__cordisxPreparedReactRuntime !== undefined) {
    return
  }
  globalThis.__cordisxPreparedReactRuntime = Object.freeze({
    React,
    reactDom: ReactDOM,
    reactDomClient: ReactDOMClient,
    jsxRuntime,
    jsxDevRuntime,
  })
}
