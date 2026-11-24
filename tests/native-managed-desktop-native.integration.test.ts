import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { nativeManagedDesktopFiles } from '../packages/cli/src/launcher/native-managed-desktop.js'
import { type CodexAppServerRpc, startLocalCodexAppServer } from '../packages/cli/src/providers/codex-app-server.js'

const executable = process.env.CORDISX_MANAGED_DESKTOP_NATIVE_TEST_EXECUTABLE
it.skipIf(!executable)('loads a generated catalog with an unknown context window in native Codex', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-desktop-catalog-'))
  let native: CodexAppServerRpc | undefined
  try {
    const catalogPath = path.join(root, 'models.json')
    const files = nativeManagedDesktopFiles([{
      providerId: 'fixture',
      connection: {
        service: { pluginId: 'plugin', serviceId: 'gateway', generation: 'one' },
        endpoint: { origin: 'http://127.0.0.1:1', apiPath: '/v1', auth: { scheme: 'none' } },
        models: {
          generation: 'one',
          defaultAlias: 'model',
          aliases: [{ alias: 'model', gatewayModelId: 'unknown-model' }],
        },
        cleanup: { authorityId: 'fixture' },
      },
    }], catalogPath)
    const row = JSON.parse(files.catalogJson).models[0]
    expect(row).not.toHaveProperty('context_window')
    expect(row).not.toHaveProperty('max_context_window')
    await writeFile(catalogPath, files.catalogJson)
    await writeFile(path.join(root, 'config.toml'), files.configToml)
    native = await startLocalCodexAppServer({
      id: 'fixture',
      kind: 'local-codex',
      displayName: 'fixture',
      sourceProviderId: 'codex',
      codexExecutable: executable!,
      codexHome: root,
      enabled: true,
      timeoutMs: 10_000,
    }, {
      environment: {
        PATH: process.env.PATH,
        HOME: root,
        CODEX_HOME: root,
        NO_PROXY: '127.0.0.1,localhost',
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
      },
    })
    const config = await native.request<{ config: { model_catalog_json: string } }>('config/read', {
      cwd: root,
      includeLayers: false,
    })
    expect(config.config.model_catalog_json).toBe(catalogPath)
    const list = await native.request<{ data: Array<{ model: string }> }>('model/list', { limit: 100 })
    expect(list.data.some(model => model.model === 'unknown-model')).toBe(true)
    const created = await native.request<{ thread: { id: string } }>('thread/start', {
      modelProvider: 'fixture',
      model: 'unknown-model',
      cwd: root,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    })
    expect(created.thread.id).toBeTruthy()
  } finally {
    await native?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
