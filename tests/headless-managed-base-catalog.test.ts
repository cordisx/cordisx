import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { prepareHeadlessManagedBaseCatalog } from '../packages/cli/src/launcher/headless-managed-base-catalog.js'
import { startLocalCodexAppServer } from '../packages/cli/src/providers/codex-app-server.js'

const bytes = Buffer.from(JSON.stringify({ models: [{ slug: 'fixture', marker: 'original' }] }))
function mockProbe(input: { catalog?: string | null; requirements?: unknown; change?: boolean } = {}) {
  let reads = 0
  const close = vi.fn(async () => {})
  const request = vi.fn(async (method: string) => {
    if (method === 'config/read') {
      return {
        config: {
          model_provider: input.change && ++reads > 1 ? 'changed' : 'fixture',
          model_catalog_json: input.catalog ?? null,
        },
      }
    }
    if (method === 'configRequirements/read') return { requirements: input.requirements ?? null }
    throw new Error('unexpected request')
  })
  return { startProbe: async () => ({ request, close }) as never, close }
}

describe('headless managed native base catalog', () => {
  it('freezes complete debug output after unchanged native config and requirements', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-base-'))
    const probe = mockProbe(), runDebug = vi.fn(async () => bytes.toString())
    const value = await prepareHeadlessManagedBaseCatalog({
      nativeVersion: '0.149.1',
      executable: '/fixture',
      codexHome: root,
      userHome: root,
      environment: {},
      startProbe: probe.startProbe,
      runDebug,
    })
    try {
      expect(value).toBeDefined()
      expect(await readFile(value!.path)).toEqual(bytes)
      expect((await stat(value!.path)).mode & 0o777).toBe(0o400)
      expect(runDebug).toHaveBeenCalledOnce()
      expect(probe.close).toHaveBeenCalledOnce()
    } finally {
      await value?.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves an explicitly configured catalog instead of replacing it with a debug default', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-base-explicit-'))
    const file = path.join(root, 'user-catalog.json')
    await writeFile(file, bytes)
    const runDebug = vi.fn(async () => 'should not run')
    const value = await prepareHeadlessManagedBaseCatalog({
      nativeVersion: '0.149.1',
      executable: '/fixture',
      codexHome: root,
      userHome: root,
      environment: {},
      startProbe: mockProbe({ catalog: file }).startProbe,
      runDebug,
    })
    try {
      expect(value).toBeDefined()
      expect(await readFile(value!.path)).toEqual(bytes)
      expect(await readFile(file)).toEqual(bytes)
      expect(runDebug).not.toHaveBeenCalled()
    } finally {
      await value?.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the native catalog unchanged when requirements, config, or input cannot be verified', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-base-rejected-'))
    const cases = [
      { nativeVersion: 'other', startProbe: mockProbe().startProbe, runDebug: async () => bytes.toString() },
      {
        nativeVersion: '0.149.1',
        startProbe: mockProbe({ change: true }).startProbe,
        runDebug: async () => bytes.toString(),
      },
      {
        nativeVersion: '0.149.1',
        startProbe: mockProbe({ requirements: { modelProvider: 'locked' } }).startProbe,
        runDebug: async () => bytes.toString(),
      },
      {
        nativeVersion: '0.149.1',
        startProbe: mockProbe().startProbe,
        runDebug: async () => JSON.stringify({ models: [{ slug: 'x' }, { slug: 'x' }] }),
      },
      {
        nativeVersion: '0.149.1',
        startProbe: mockProbe().startProbe,
        runDebug: async () => {
          throw new Error('unavailable')
        },
      },
    ]
    try {
      for (const value of cases) {
        expect(
          await prepareHeadlessManagedBaseCatalog({
            executable: '/fixture',
            codexHome: root,
            userHome: root,
            environment: {},
            ...value,
          }),
        ).toBeUndefined()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

const executable = process.env.CORDISX_MANAGED_NATIVE_TEST_EXECUTABLE
it.skipIf(!executable)('freezes the real native model directory in an isolated logged-out home', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-base-native-'))
  const codexHome = path.join(root, 'codex')
  await mkdir(codexHome)
  const environment = { PATH: process.env.PATH, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' }
  let value: Awaited<ReturnType<typeof prepareHeadlessManagedBaseCatalog>>
  let server: Awaited<ReturnType<typeof startLocalCodexAppServer>> | undefined
  try {
    value = await prepareHeadlessManagedBaseCatalog({
      nativeVersion: '0.149.1',
      executable: executable!,
      codexHome,
      userHome: root,
      environment,
    })
    expect(value).toBeDefined()
    server = await startLocalCodexAppServer({
      id: 'fixture',
      kind: 'local-codex',
      displayName: 'fixture',
      sourceProviderId: 'codex',
      codexExecutable: executable!,
      codexHome,
      enabled: true,
      timeoutMs: 10_000,
    }, {
      environment: { ...environment, HOME: root },
      experimentalApi: true,
      modelCatalogPath: value!.path,
      modelCatalogPreserveProvider: true,
    })
    const config = await server.request<{ config: Record<string, unknown> }>('config/read', {
      cwd: codexHome,
      includeLayers: false,
    })
    expect(config.config.model_catalog_json).toBe(value!.path)
    const list = await server.request<{ data: unknown[] }>('model/list', { limit: 100 })
    expect(list.data.length).toBeGreaterThan(0)
  } finally {
    await server?.close()
    await value?.close()
    await rm(root, { recursive: true, force: true })
  }
})
