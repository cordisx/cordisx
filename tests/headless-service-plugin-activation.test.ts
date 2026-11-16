import { expect, it } from 'vitest'
import { createServicePluginRuntime } from '../packages/cli/src/launcher/service-plugin-runtime.js'
import type { PluginRuntimeMutation } from '../packages/cli/src/launcher/plugin-lifecycle-model.js'

it('refuses a Channel activation change while the service owns its ingress', async () => {
  const runtime = createServicePluginRuntime('test')
  const fence = runtime.prepare!('tx')
  const previous = { plugins: [{ id: 'channel', enabled: true }] }
  const candidate = { plugins: [{ id: 'channel', enabled: false }] }
  const mutation = {
    transactionId: 'tx',
    transactionEpoch: fence.transactionEpoch,
    expectedRegistryEpoch: fence.expectedRegistryEpoch,
    afterRegistryEpoch: fence.expectedRegistryEpoch + 1,
    previous,
    candidate,
  } as unknown as PluginRuntimeMutation
  await expect(runtime.stage(mutation)).rejects.toThrow('Stop service mode before changing Channel activation')
  await runtime.abort('tx')
})
