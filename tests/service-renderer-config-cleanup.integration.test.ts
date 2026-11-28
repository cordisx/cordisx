import { randomBytes } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'releases profile resources when clearing a configuration projection fails',
  async () => {
    const projection = {
      project: vi.fn(async () => ({})),
      clear: vi.fn(() => {
        throw new Error('synthetic projection cleanup failure')
      }),
    }
    const f = await fixture({ protectProfileInputs: true, projectPluginConfig: projection })
    const addPlugin = async () =>
      await updateHomeConfigAtomic(current => ({
        ...current,
        plugins: [{ id: 'fixture-config', entry: '/fixture/plugin.js' }],
      }), f.configPath)
    try {
      expect(await f.call({ action: 'prepare' })).toMatchObject({ status: 'ok' })
      await expect(addPlugin()).rejects.toThrow('plugin configuration is in use')
      expect(await f.sessions.close(f.invocation)).toBe(false)
      expect(projection.clear).toHaveBeenCalledOnce()
      await addPlugin()
      expect(await f.sessions.open(f.gateway, randomBytes(32).toString('hex'))).toBeUndefined()
    } finally {
      await f.close()
    }
  },
  30_000,
)
