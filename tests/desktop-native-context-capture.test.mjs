import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDesktopNativeContextCapture } from '../packages/cli/assets/launcher/desktop-native-context-capture.mjs'
import { deriveNativeBudgetProvenance } from '../packages/cli/src/launcher/native-context-budget-provenance.ts'

describe('Desktop launch-owned context capture', () => {
  it('binds the actual request and invalidates on a later model change', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cx-desktop-capture-test-'))
    try {
      const catalogPath = path.join(dir, 'catalog.json')
      const bytes = Buffer.from(
        JSON.stringify({
          models: [{
            slug: 'm',
            context_window: 100000,
            max_context_window: 100000,
            auto_compact_token_limit: 80000,
            effective_context_window_percent: 80,
          }],
        }),
      )
      await writeFile(catalogPath, bytes)
      const sha256 = createHash('sha256').update(bytes).digest('hex'), events = []
      const capture = createDesktopNativeContextCapture({
        path: catalogPath,
        sha256,
        nativeVersion: '0.167.0-alpha.3.2',
        serverId: 'server',
        read: async method =>
          method === 'config/read'
            ? { config: { model_catalog_json: catalogPath, model: 'm', model_provider: 'openai', features: {} } }
            : { requirements: null },
        emit: async (method, params) => events.push({ method, params }),
      })
      const params = { cwd: '/tmp', config: { approval_policy: 'never' } }
      const preflight = await capture.prepare('thread/start', params)
      const handle = capture.bind(preflight, 'native-7', params)
      expect(params).toMatchObject({
        model: 'm',
        config: { approval_policy: 'never', model_context_window: 100000, model_auto_compact_token_limit: 80000 },
      })
      await capture.finish(handle, 'native-7', params, { thread: { id: 's' }, model: 'm', modelProvider: 'openai' })
      expect(events).toHaveLength(1)
      expect(
        deriveNativeBudgetProvenance({
          nativeVersion: '0.167.0-alpha.3.2',
          serverId: 'server',
          providerId: 'openai',
          providerKind: 'openai-compatible',
          catalogBytes: bytes,
          catalogSha256: sha256,
        }, events[0].params).status,
      ).toBe('verified')
      await capture.invalidate('thread/settings/update', { threadId: 's', model: 'different' })
      expect(events[1]).toEqual({ method: 'cordisx/context/invalidate', params: { threadId: 's' } })
      await writeFile(catalogPath, '{}')
      expect(await capture.prepare('thread/start', { cwd: '/tmp' })).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
