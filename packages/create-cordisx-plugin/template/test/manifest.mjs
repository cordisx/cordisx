import assert from 'node:assert/strict'
import test from 'node:test'

const component = () => null
const noop = () => undefined
const React = new Proxy({ Fragment: Symbol('Fragment'), Suspense: component, lazy: () => component }, {
  get(target, property) { return Reflect.get(target, property) ?? noop },
})
globalThis.__cordisxSharedReactRuntime = {
  React,
  defineReactPage: page => page,
  jsxRuntime: { Fragment: React.Fragment, jsx: component, jsxs: component },
  jsxDevRuntime: { Fragment: React.Fragment, jsxDEV: component },
  ui: new Proxy({}, { get: () => component }),
}

const { apply, inject, manifest } = await import('../dist/runtime/module.js')

test('exports a minimal CordisX plugin module', () => {
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.id, '{{pluginId}}')
  assert.deepEqual(manifest.capabilities, [])
  assert.deepEqual(inject, ['i18n', 'pages', 'routes', 'slots'])
  assert.equal(typeof apply, 'function')
})
