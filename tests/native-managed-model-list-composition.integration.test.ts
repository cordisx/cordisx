import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createNativeSubmissionComposition } from '../packages/cli/src/launcher/native-submission-composition.js'
import { bundle } from './fixtures/native-app-bundle.js'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.skipIf(process.platform !== 'darwin')(
  'wires the actual Codex composition catalog to the native intermediary',
  async () => {
    const f = await bundle(roots)
    const home = await mkdtemp(path.join(os.tmpdir(), 'cx-model-list-home-'))
    roots.push(home)
    vi.stubEnv('CORDISX_HOME', home)
    vi.stubEnv('CORDISX_MODEL_API_PORT', '0')
    const codexHome = path.join(home, 'codex')
    await mkdir(codexHome)
    const composition = await createNativeSubmissionComposition(
      {
        nativeProviderIds: ['plugin-a'],
        prepareNativeConnection: () => ({
          value: {
            service: { pluginId: 'fixture-plugin', serviceId: 'gateway', generation: 'generation' },
            endpoint: {
              origin: 'https://plugin.example.test',
              apiPath: '/v1' as const,
              auth: { scheme: 'none' as const },
            },
            models: {
              generation: 'models',
              defaultAlias: 'model-a',
              aliases: [{
                alias: 'model-a',
                gatewayModelId: 'model-a',
                reasoningCapabilities: { efforts: ['low', 'high'] as const, defaultEffort: 'high' as const },
              }],
            },
            cleanup: { authorityId: 'generation' },
          },
          dispose() {},
        }),
      },
      f.executable,
      codexHome,
      { nativeModelDiscovery: false },
    )
    const intermediary = path.resolve('packages/cli/assets/launcher/native-app-server-protocol.mjs')
    const fixture = path.resolve('tests/fixtures/native-model-list-app-server.mjs')
    const child = spawn(process.execPath, [intermediary, fixture], {
      env: { ...process.env, ...composition.environment, CORDISX_NATIVE_REAL_CODEX_PATH: process.execPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = once(child, 'close')
    let buffer = ''
    child.stdout.on('data', data => {
      buffer += String(data)
    })
    try {
      child.stdin.write(
        JSON.stringify({ id: 'list', method: 'model/list', params: { modelProvider: 'plugin-a' } }) + '\n',
      )
      await vi.waitFor(() => expect(buffer).toContain('\n'), { timeout: 3000 })
      const response = JSON.parse(buffer.split('\n')[0]!)
      expect(response).toMatchObject({
        id: 'list',
        result: {
          data: [
            { id: 'model-a', defaultReasoningEffort: 'high', inputModalities: ['text', 'image', 'audio'] },
          ],
        },
      })
    } finally {
      child.stdin.end()
      await exited
      await composition.close()
    }
  },
)
