import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  headlessLiveBudgetEnabled,
  prepareHeadlessStaticCatalog,
} from '../packages/cli/src/launcher/headless-static-catalog.js'

describe('owned headless catalog', () => {
  it('freezes only model records for a new server, and never overwrites a configured catalog', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-static-test-'))
    try {
      await writeFile(
        path.join(directory, 'models_cache.json'),
        JSON.stringify({ identity: 'not-catalog', models: [{ slug: 'model' }] }),
      )
      let custom = false
      let provider = 'openai'
      const close = vi.fn(async () => {})
      const startProbe = vi.fn(async () => ({
        generation: 'probe',
        close,
        request: async (method: string) =>
          method === 'config/read'
            ? { config: { model_provider: provider, model_catalog_json: custom ? '/existing/catalog.json' : null } }
            : { requirements: null },
      }))
      const input = {
        enabled: true,
        nativeVersion: '0.167.0-alpha.3.2',
        executable: '/isolated/codex',
        codexHome: directory,
        userHome: directory,
        cwd: directory,
        environment: {},
        startProbe: startProbe as never,
      }
      const lease = await prepareHeadlessStaticCatalog(input)
      expect(lease).toBeDefined()
      expect(JSON.parse(await readFile(lease!.path, 'utf8'))).toEqual({ models: [{ slug: 'model' }] })
      expect((await stat(lease!.path)).mode & 0o777).toBe(0o400)
      await lease!.close()
      await expect(stat(lease!.path)).rejects.toMatchObject({ code: 'ENOENT' })
      custom = true
      expect(await prepareHeadlessStaticCatalog(input)).toBeUndefined()
      custom = false
      provider = 'gcp'
      expect(await prepareHeadlessStaticCatalog(input)).toBeUndefined()
      expect(close).toHaveBeenCalledTimes(3)
      expect(JSON.parse(await readFile(path.join(directory, 'models_cache.json'), 'utf8')).identity).toBe('not-catalog')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('requires an explicit persisted opt-in', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-static-policy-')),
      file = path.join(directory, 'state.json')
    try {
      expect(await headlessLiveBudgetEnabled(file)).toBe(false)
      await writeFile(file, JSON.stringify({ continuationDefaults: { policy: { enabled: true } } }))
      expect(await headlessLiveBudgetEnabled(file)).toBe(true)
      await writeFile(
        file,
        JSON.stringify({
          continuationDefaults: { policy: { enabled: false } },
          continuations: { a: { livePolicy: { overrides: { enabled: true } } } },
        }),
      )
      expect(await headlessLiveBudgetEnabled(file)).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
