import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeManagedGatewayConnection } from '../packages/cli/src/launcher/managed-service-native-connection.js'
import {
  nativeManagedDesktopFiles,
  prepareNativeManagedDesktop,
  refreshNativeManagedDesktop,
} from '../packages/cli/src/launcher/native-managed-desktop.js'

const temporaryDirectories: string[] = []

function connection(input: {
  readonly providerId: string
  readonly token?: string
  readonly origin?: string
  readonly apiPath?: `/${string}`
  readonly defaultAlias: string
  readonly aliases: readonly { readonly alias: string; readonly gatewayModelId: string }[]
}): { readonly providerId: string; readonly connection: NativeManagedGatewayConnection } {
  return {
    providerId: input.providerId,
    connection: {
      service: { pluginId: `${input.providerId}-plugin`, serviceId: 'cli-proxy-api', generation: 'service-one' },
      endpoint: {
        origin: input.origin ?? 'http://127.0.0.1:8317',
        apiPath: input.apiPath ?? '/v1',
        auth: { scheme: 'bearer', token: input.token ?? 'secret-token' },
      },
      models: {
        generation: `${input.providerId}-catalog`,
        defaultAlias: input.defaultAlias,
        aliases: input.aliases,
      },
      cleanup: { authorityId: `${input.providerId}-authority` },
    },
  }
}

function providers() {
  return [
    connection({
      providerId: 'aiden',
      defaultAlias: 'dyai-gpt-5.6-sol',
      aliases: [
        { alias: 'dyai-gpt-5.6-sol', gatewayModelId: 'aiden/dyai-gpt-5.6-sol' },
        { alias: 'dyai-gpt-5.4', gatewayModelId: 'aiden/dyai-gpt-5.4' },
      ],
    }),
    connection({
      providerId: 'traex',
      defaultAlias: 'seed-2.1-pro',
      aliases: [{ alias: 'seed-2.1-pro', gatewayModelId: 'traex/seed-2.1-pro' }],
    }),
  ]
}

function sharedModelProviders() {
  return [
    connection({
      providerId: 'aiden',
      token: 'aiden-token',
      defaultAlias: 'sol',
      aliases: [
        { alias: 'sol', gatewayModelId: 'gpt-5.6-sol' },
        { alias: 'best', gatewayModelId: 'gpt-5.6-sol' },
      ],
    }),
    connection({
      providerId: 'traex',
      token: 'traex-token',
      origin: 'https://gateway.example.test',
      apiPath: '/responses/v1',
      defaultAlias: 'sol-pro',
      aliases: [{ alias: 'sol-pro', gatewayModelId: 'gpt-5.6-sol' }],
    }),
  ]
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async directory =>
      await rm(directory, {
        recursive: true,
        force: true,
      })
    ),
  )
})

describe('native managed Desktop configuration', () => {
  it('builds a logged-out isolated configuration with no provider defaults', () => {
    const files = nativeManagedDesktopFiles([], '/private/cordisx/models.json', {
      credentialMode: 'private-config',
    })

    expect(files.providers).toEqual([])
    expect(files.modelIds).toEqual([])
    expect(files.defaultProviderId).toBeUndefined()
    expect(files.defaultModelId).toBeUndefined()
    expect(files.activeProviderId).toBeUndefined()
    expect(files.activeModelId).toBeUndefined()
    expect(files.environment).toEqual({})
    expect(JSON.parse(files.catalogJson)).toEqual({ models: [] })
    expect(files.configToml).not.toContain('model =')
    expect(files.configToml).not.toContain('model_provider =')
    expect(files.configToml).not.toContain('model_providers =')
    expect(files.configToml).toContain('model_catalog_json = "/private/cordisx/models.json"')
  })

  it('builds one native catalog with exact Aiden and TraeX gateway model ids', () => {
    const files = nativeManagedDesktopFiles(providers(), '/private/cordisx/models.json')
    const catalog = JSON.parse(files.catalogJson) as {
      readonly models: readonly { readonly slug: string; readonly display_name: string }[]
    }

    expect(files.defaultModelId).toBe('aiden/dyai-gpt-5.6-sol')
    expect(files.modelIds).toEqual([
      'aiden/dyai-gpt-5.6-sol',
      'aiden/dyai-gpt-5.4',
      'traex/seed-2.1-pro',
    ])
    expect(catalog.models.map(model => model.slug)).toEqual(files.modelIds)
    expect(catalog.models.map(model => model.display_name)).toEqual([
      'aiden: dyai-gpt-5.6-sol',
      'aiden: dyai-gpt-5.4',
      'traex: seed-2.1-pro',
    ])
    expect(files.configToml).toContain('model_provider = "aiden"')
    expect(files.configToml).toContain('base_url = "http://127.0.0.1:8317/v1"')
    expect(files.configToml).toContain('model_catalog_json = "/private/cordisx/models.json"')
    expect(files.configToml).not.toContain(files.token)
    expect(files.catalogJson).not.toContain(files.token)
    expect(files.defaultProviderId).toBe('aiden')
    expect(files.providers.map(provider => provider.providerId)).toEqual(['aiden', 'traex'])
  })

  it('builds independent provider endpoints and credentials while sharing actual model ids', () => {
    const files = nativeManagedDesktopFiles(sharedModelProviders(), '/private/cordisx/models.json')
    const catalog = JSON.parse(files.catalogJson) as { readonly models: readonly { readonly slug: string }[] }

    expect(files.environment.CODEX_HOME).toBeUndefined()
    expect(files.environment.CORDISX_NATIVE_MANAGED_TOKEN).toBe('aiden-token')
    expect(Object.values(files.environment)).toContain('traex-token')
    expect(Object.keys(files.environment)).toHaveLength(2)
    expect(files.configToml).toContain('"aiden" = {')
    expect(files.configToml).toContain('"traex" = {')
    expect(files.configToml).toContain('base_url = "https://gateway.example.test/responses/v1"')
    expect(files.configToml).not.toContain('aiden-token')
    expect(files.configToml).not.toContain('traex-token')
    expect(catalog.models.map(model => model.slug)).toEqual(['gpt-5.6-sol'])
    expect(files.modelIds).toEqual(['gpt-5.6-sol'])
    expect(files.providers).toEqual([
      {
        providerId: 'aiden',
        models: [{ id: 'gpt-5.6-sol', label: 'sol', aliases: ['sol', 'best'] }],
        modelIds: ['gpt-5.6-sol'],
        defaultModelId: 'gpt-5.6-sol',
      },
      {
        providerId: 'traex',
        models: [{ id: 'gpt-5.6-sol', label: 'sol-pro', aliases: ['sol-pro'] }],
        modelIds: ['gpt-5.6-sol'],
        defaultModelId: 'gpt-5.6-sol',
      },
    ])
  })

  it('rejects duplicate provider ids', () => {
    expect(() =>
      nativeManagedDesktopFiles([
        providers()[0]!,
        connection({
          providerId: 'aiden',
          defaultAlias: 'other',
          aliases: [{ alias: 'other', gatewayModelId: 'other-model' }],
        }),
      ], '/private/cordisx/models.json')
    ).toThrow('duplicate or empty native managed provider id')
  })

  it('rejects an explicit selection that is absent from the generated catalog', () => {
    expect(() =>
      nativeManagedDesktopFiles(providers(), '/private/cordisx/models.json', {
        selection: { providerId: 'gone', modelId: 'missing' },
      })
    ).toThrow('native managed selection is unavailable: gone/missing')
  })

  it('keeps unauthenticated loopback providers free of invented credentials', () => {
    const item = connection({
      providerId: 'direct-local',
      defaultAlias: 'model',
      aliases: [{ alias: 'model', gatewayModelId: 'model' }],
    })
    const local = {
      ...item,
      connection: { ...item.connection, endpoint: { ...item.connection.endpoint, auth: { scheme: 'none' as const } } },
    }
    for (const credentialMode of ['environment', 'private-config'] as const) {
      const files = nativeManagedDesktopFiles([local], '/private/cordisx/models.json', { credentialMode })
      expect(files.environment).toEqual({})
      expect(files.token).toBeUndefined()
      expect(files.configToml).not.toContain('env_key')
      expect(files.configToml).not.toContain('experimental_bearer_token')
      expect(files.configToml).toContain('requires_openai_auth = false')
    }
    expect(() =>
      nativeManagedDesktopFiles([{
        ...local,
        connection: {
          ...local.connection,
          endpoint: { ...local.connection.endpoint, origin: 'https://remote.example.test' },
        },
      }], '/private/cordisx/models.json')
    ).toThrow('Unauthenticated managed providers must use loopback')
  })

  it('validates exact endpoint URLs and TOML-escapes provider data', () => {
    for (
      const origin of [
        'http://example.test:8317',
        'http://127.0.0.1:8317/extra',
        'https://gateway.example.test/path',
        'https://gateway.example.test?query=yes',
      ]
    ) {
      expect(() =>
        nativeManagedDesktopFiles([
          connection({
            providerId: 'unsafe',
            origin,
            defaultAlias: 'model',
            aliases: [{ alias: 'model', gatewayModelId: 'model' }],
          }),
        ], '/private/cordisx/models.json')
      ).toThrow('exact loopback HTTP or HTTPS URL')
    }

    const escaped = nativeManagedDesktopFiles([
      connection({
        providerId: 'quoted"provider',
        origin: 'https://gateway.example.test',
        defaultAlias: 'quoted',
        aliases: [{ alias: 'quoted', gatewayModelId: 'model"quoted' }],
      }),
    ], '/private/cordisx/models.json')
    expect(escaped.configToml).toContain('model_provider = "quoted\\"provider"')
    expect(escaped.configToml).toContain('"quoted\\"provider" = {')
    expect(JSON.parse(escaped.catalogJson).models[0].slug).toBe('model"quoted')
  })

  it('supports private config credentials without exposing them in descriptors or the catalog', () => {
    const files = nativeManagedDesktopFiles(sharedModelProviders(), '/private/cordisx/models.json', {
      credentialMode: 'private-config',
    })

    expect(files.environment).toEqual({})
    expect(files.configToml).toContain('experimental_bearer_token = "aiden-token"')
    expect(files.configToml).toContain('experimental_bearer_token = "traex-token"')
    expect(files.configToml).not.toContain('env_key =')
    expect(files.catalogJson).not.toContain('aiden-token')
    expect(files.catalogJson).not.toContain('traex-token')
    expect(JSON.stringify(files.providers)).not.toContain('token')
  })

  it('writes a private CordisX-owned CODEX_HOME without persisting the bearer token', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-native-desktop-'))
    temporaryDirectories.push(homeDir)
    const sourceCodexHome = path.join(homeDir, 'source-codex-home')
    await mkdir(sourceCodexHome)
    const sourceAuthPath = path.join(sourceCodexHome, 'auth.json')
    const sourceAuth = '{"auth_mode":"chatgpt","marker":"preserved-login"}\n'
    await writeFile(sourceAuthPath, sourceAuth, { mode: 0o640 })
    const sourceBefore = await stat(sourceAuthPath)
    const launch = await prepareNativeManagedDesktop({
      homeDir,
      profileId: 'work',
      sourceCodexHome,
      connections: providers(),
    })
    const configToml = await readFile(path.join(launch.codexHome, 'config.toml'), 'utf8')
    const catalogJson = await readFile(launch.catalogPath, 'utf8')
    const authPath = path.join(launch.codexHome, 'auth.json')
    const copiedAuth = await readFile(authPath, 'utf8')
    const sourceAfter = await stat(sourceAuthPath)
    const copiedMetadata = await stat(authPath)

    expect(launch.environment.CODEX_HOME).toBe(launch.codexHome)
    expect(launch.environment.CORDISX_NATIVE_MANAGED_TOKEN).toBe('secret-token')
    expect(Object.values(launch.environment).filter(value => value === 'secret-token')).toHaveLength(2)
    expect(configToml).not.toContain('secret-token')
    expect(catalogJson).not.toContain('secret-token')
    expect(copiedAuth).toBe(sourceAuth)
    expect(authPath).not.toBe(sourceAuthPath)
    expect(copiedMetadata.ino).not.toBe(sourceAfter.ino)
    expect(sourceAfter.ino).toBe(sourceBefore.ino)
    expect(sourceAfter.mode).toBe(sourceBefore.mode)
    expect(await readFile(sourceAuthPath, 'utf8')).toBe(sourceAuth)
    const persistedFiles = await Promise.all([
      readFile(path.join(launch.codexHome, 'config.toml'), 'utf8'),
      readFile(launch.catalogPath, 'utf8'),
      readFile(authPath, 'utf8'),
    ])
    expect(persistedFiles.join('\n')).not.toContain('secret-token')
    expect(launch.modelIds).toEqual([
      'aiden/dyai-gpt-5.6-sol',
      'aiden/dyai-gpt-5.4',
      'traex/seed-2.1-pro',
    ])
    if (process.platform !== 'win32') {
      expect((await stat(launch.codexHome)).mode & 0o777).toBe(0o700)
      expect((await stat(path.join(launch.codexHome, 'config.toml'))).mode & 0o777).toBe(0o600)
      expect((await stat(launch.catalogPath)).mode & 0o777).toBe(0o600)
      expect(copiedMetadata.mode & 0o777).toBe(0o600)
      expect(sourceAfter.mode & 0o777).toBe(0o640)
    }
  })

  it.runIf(process.platform !== 'win32')('copies a resolved auth symlink target into the private overlay', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-native-desktop-symlink-'))
    temporaryDirectories.push(homeDir)
    const sourceCodexHome = path.join(homeDir, 'source-codex-home')
    const authTarget = path.join(homeDir, 'account', 'auth.json')
    await mkdir(path.dirname(authTarget), { recursive: true })
    await mkdir(sourceCodexHome)
    await writeFile(authTarget, '{"marker":"symlink-login"}\n', { mode: 0o600 })
    await symlink(authTarget, path.join(sourceCodexHome, 'auth.json'))

    const launch = await prepareNativeManagedDesktop({
      homeDir,
      profileId: 'work',
      sourceCodexHome,
      connections: providers(),
    })
    const copiedAuthPath = path.join(launch.codexHome, 'auth.json')

    expect(await readFile(copiedAuthPath, 'utf8')).toBe('{"marker":"symlink-login"}\n')
    expect((await lstat(copiedAuthPath)).isSymbolicLink()).toBe(false)
    expect((await stat(copiedAuthPath)).ino).not.toBe((await stat(authTarget)).ino)
    expect(await readFile(authTarget, 'utf8')).toBe('{"marker":"symlink-login"}\n')
  })

  it('removes a stale overlay credential when the source is not logged in', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-native-desktop-missing-auth-'))
    temporaryDirectories.push(homeDir)
    const sourceCodexHome = path.join(homeDir, 'source-codex-home')
    await mkdir(sourceCodexHome)
    const launch = await prepareNativeManagedDesktop({
      homeDir,
      profileId: 'work',
      sourceCodexHome,
      connections: providers(),
    })
    const copiedAuthPath = path.join(launch.codexHome, 'auth.json')
    await writeFile(copiedAuthPath, '{"marker":"stale"}\n')

    await prepareNativeManagedDesktop({
      homeDir,
      profileId: 'work',
      sourceCodexHome,
      connections: providers(),
    })

    await expect(stat(copiedAuthPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refreshes provider files without resnapshotting auth and preserves a valid selection', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-native-desktop-refresh-'))
    temporaryDirectories.push(homeDir)
    const sourceCodexHome = path.join(homeDir, 'source-codex-home')
    await mkdir(sourceCodexHome)
    await writeFile(path.join(sourceCodexHome, 'auth.json'), '{"marker":"source"}\n')
    const initial = await prepareNativeManagedDesktop({
      homeDir,
      profileId: 'work',
      sourceCodexHome,
      connections: sharedModelProviders(),
      credentialMode: 'private-config',
    })
    const authPath = path.join(initial.codexHome, 'auth.json')
    await writeFile(authPath, '{"marker":"overlay-change"}\n')
    const customConfig = [
      'model_reasoning_effort = "high"',
      'custom_model = "leave-me-alone"',
      '',
      '[features]',
      'js_repl = true',
      '',
      '[custom.service]',
      'endpoint = "https://example.test"',
      '',
    ].join('\n')
    const initialConfig = await readFile(path.join(initial.codexHome, 'config.toml'), 'utf8')
    await writeFile(
      path.join(initial.codexHome, 'config.toml'),
      `# BEGIN CORDISX NATIVE MANAGED CONFIG\n${initialConfig.trimEnd()}\nmodel_reasoning_effort = "high"\n# END CORDISX NATIVE MANAGED CONFIG\n\n${
        customConfig.replace('model_reasoning_effort = "high"\n', '')
      }`,
    )

    const refreshed = await refreshNativeManagedDesktop({
      codexHome: initial.codexHome,
      connections: sharedModelProviders(),
      credentialMode: 'private-config',
      selection: { providerId: 'traex', modelId: 'gpt-5.6-sol' },
    })
    const configToml = await readFile(path.join(initial.codexHome, 'config.toml'), 'utf8')

    expect(configToml).toContain('model_provider = "traex"')
    expect(configToml).toContain('model = "gpt-5.6-sol"')
    expect(configToml).toContain('model_reasoning_effort = "high"')
    expect(configToml).toContain('custom_model = "leave-me-alone"')
    expect(configToml).toContain('[features]\njs_repl = true')
    expect(configToml).toContain('[custom.service]\nendpoint = "https://example.test"')
    expect(await readFile(authPath, 'utf8')).toBe('{"marker":"overlay-change"}\n')
    expect(refreshed.providers).toEqual(initial.providers)
    expect(refreshed.environment).toEqual({ CODEX_HOME: initial.codexHome })
    if (process.platform !== 'win32') {
      expect((await stat(path.join(initial.codexHome, 'config.toml'))).mode & 0o777).toBe(0o600)
    }

    await refreshNativeManagedDesktop({
      codexHome: initial.codexHome,
      connections: sharedModelProviders(),
      credentialMode: 'private-config',
    })
    expect(await readFile(path.join(initial.codexHome, 'config.toml'), 'utf8')).toContain(
      'model_provider = "traex"',
    )
  })

  it('parses formatted root selection without touching similarly named keys or custom tables', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-native-desktop-formatted-'))
    temporaryDirectories.push(homeDir)
    const codexHome = path.join(homeDir, 'native-managed-codex-home')
    await mkdir(codexHome)
    await writeFile(
      path.join(codexHome, 'config.toml'),
      [
        'model_provider= "traex#edge" # selected provider',
        "model = 'gpt#5.6-sol' # selected model",
        'model_reasoning_effort = "high"',
        'model_provider_backup = "custom"',
        '',
        '[model_providers.stale]',
        'name = "CordisX Managed (stale)"',
        'base_url = "https://stale.example.test/v1"',
        'wire_api = "responses"',
        '',
        '[model_providers.custom]',
        'name = "Custom provider"',
        'base_url = "https://custom.example.test/v1"',
        'wire_api = "responses"',
        '',
        '[custom.table]',
        'model = "table-owned"',
        '',
      ].join('\n'),
    )

    await refreshNativeManagedDesktop({
      codexHome,
      connections: [connection({
        providerId: 'traex#edge',
        token: 'traex-token',
        origin: 'https://gateway.example.test',
        apiPath: '/responses/v1',
        defaultAlias: 'sol-pro',
        aliases: [{ alias: 'sol-pro', gatewayModelId: 'gpt#5.6-sol' }],
      })],
      credentialMode: 'private-config',
    })
    const configToml = await readFile(path.join(codexHome, 'config.toml'), 'utf8')

    expect(configToml).toContain('model_provider = "traex#edge"')
    expect(configToml).toContain('model = "gpt#5.6-sol"')
    expect(configToml).toContain('model_reasoning_effort = "high"')
    expect(configToml).toContain('model_provider_backup = "custom"')
    expect(configToml).toContain('[model_providers."traex#edge"]')
    expect(configToml).toContain('[model_providers.custom]\nname = "Custom provider"')
    expect(configToml).toContain('[custom.table]\nmodel = "table-owned"')
    expect(configToml).not.toContain('stale.example.test')
  })

  it('serializes selection reads with concurrent refresh writes', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-native-desktop-serialized-'))
    temporaryDirectories.push(homeDir)
    const codexHome = path.join(homeDir, 'native-managed-codex-home')
    await mkdir(codexHome)
    await writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-5.6-sol"\nmodel_provider = "aiden"\n')

    const first = refreshNativeManagedDesktop({
      codexHome,
      connections: sharedModelProviders(),
      credentialMode: 'private-config',
      selection: { providerId: 'traex', modelId: 'gpt-5.6-sol' },
    })
    const second = refreshNativeManagedDesktop({
      codexHome,
      connections: sharedModelProviders(),
      credentialMode: 'private-config',
    })
    await Promise.all([first, second])

    const configToml = await readFile(path.join(codexHome, 'config.toml'), 'utf8')
    expect(configToml).toContain('model_provider = "traex"')
    expect(configToml.match(/name = "CordisX Managed \(/gu)).toHaveLength(2)
  })

  it('prepares logged out and later refreshes providers without resnapshotting auth', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-native-desktop-login-refresh-'))
    temporaryDirectories.push(homeDir)
    const sourceCodexHome = path.join(homeDir, 'source-codex-home')
    await mkdir(sourceCodexHome)
    await writeFile(path.join(sourceCodexHome, 'auth.json'), '{"marker":"source"}\n')
    const initial = await prepareNativeManagedDesktop({
      homeDir,
      profileId: 'work',
      sourceCodexHome,
      connections: [],
      credentialMode: 'private-config',
    })
    const authPath = path.join(initial.codexHome, 'auth.json')
    await writeFile(authPath, '{"marker":"overlay-change"}\n')

    const refreshed = await refreshNativeManagedDesktop({
      codexHome: initial.codexHome,
      connections: sharedModelProviders(),
      credentialMode: 'private-config',
    })

    expect(initial.providers).toEqual([])
    expect(initial.defaultProviderId).toBeUndefined()
    expect(refreshed.defaultProviderId).toBe('aiden')
    expect(refreshed.defaultModelId).toBe('gpt-5.6-sol')
    expect(await readFile(authPath, 'utf8')).toBe('{"marker":"overlay-change"}\n')

    const loggedOut = await refreshNativeManagedDesktop({
      codexHome: initial.codexHome,
      connections: [],
      credentialMode: 'private-config',
    })
    const loggedOutConfig = await readFile(path.join(initial.codexHome, 'config.toml'), 'utf8')
    expect(loggedOut.providers).toEqual([])
    expect(loggedOutConfig).not.toContain('mock-native')
    expect(loggedOutConfig).toContain('model_provider = "aiden"')
    expect(loggedOutConfig).toContain('model = "gpt-5.6-sol"')
    expect(loggedOutConfig).not.toContain('model_providers =')
    expect(await readFile(authPath, 'utf8')).toBe('{"marker":"overlay-change"}\n')
  })

  it('preserves an existing selection when its provider and model are unavailable during refresh', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-native-desktop-default-refresh-'))
    temporaryDirectories.push(homeDir)
    const codexHome = path.join(homeDir, 'native-managed-codex-home')
    await mkdir(codexHome)
    await writeFile(path.join(codexHome, 'config.toml'), 'model = "missing"\nmodel_provider = "gone"\n')

    const refreshed = await refreshNativeManagedDesktop({
      codexHome,
      connections: providers(),
      credentialMode: 'private-config',
    })
    const configToml = await readFile(path.join(codexHome, 'config.toml'), 'utf8')

    expect(refreshed.activeProviderId).toBe('gone')
    expect(refreshed.activeModelId).toBe('missing')
    expect(configToml).toContain('model_provider = "gone"')
    expect(configToml).toContain('model = "missing"')
  })

  it('rejects an explicit unavailable refresh selection without rewriting the existing pair', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-native-desktop-invalid-selection-'))
    temporaryDirectories.push(homeDir)
    const codexHome = path.join(homeDir, 'native-managed-codex-home')
    await mkdir(codexHome)
    const original = 'model = "custom-model"\nmodel_provider = "custom"\n'
    await writeFile(path.join(codexHome, 'config.toml'), original)

    await expect(refreshNativeManagedDesktop({
      codexHome,
      connections: providers(),
      credentialMode: 'private-config',
      selection: { providerId: 'gone', modelId: 'missing' },
    })).rejects.toThrow('native managed selection is unavailable: gone/missing')
    expect(await readFile(path.join(codexHome, 'config.toml'), 'utf8')).toBe(original)
  })

  it('preserves an existing unmanaged provider and model during managed catalog refresh', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-native-desktop-custom-selection-'))
    temporaryDirectories.push(homeDir)
    const codexHome = path.join(homeDir, 'native-managed-codex-home')
    await mkdir(codexHome)
    await writeFile(
      path.join(codexHome, 'config.toml'),
      [
        'model = "custom-model"',
        'model_provider = "custom"',
        '',
        '[model_providers.custom]',
        'name = "Custom provider"',
        'base_url = "https://custom.example.test/v1"',
        'wire_api = "responses"',
        '',
      ].join('\n'),
    )

    const refreshed = await refreshNativeManagedDesktop({
      codexHome,
      connections: providers(),
      credentialMode: 'private-config',
    })
    const configToml = await readFile(path.join(codexHome, 'config.toml'), 'utf8')

    expect(refreshed.activeProviderId).toBe('custom')
    expect(refreshed.activeModelId).toBe('custom-model')
    expect(configToml).toContain('model_provider = "custom"')
    expect(configToml).toContain('model = "custom-model"')
    expect(configToml).toContain('[model_providers.custom]\nname = "Custom provider"')
    expect(configToml).toContain('[model_providers.aiden]')
    expect(configToml).toContain('[model_providers.traex]')
  })
})
