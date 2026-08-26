import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject, manifest } from '../dist/{{pluginId}}.js'

test('exports a minimal CordisX plugin module', () => {
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.id, '{{pluginId}}')
  assert.deepEqual(manifest.capabilities, [])
  assert.deepEqual(inject, ['i18n', 'pages', 'routes', 'slots'])
  assert.equal(typeof apply, 'function')
})
