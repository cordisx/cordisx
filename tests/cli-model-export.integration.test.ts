import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultHomeConfig, loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'
import { parseCordisXCli } from '../packages/cli/src/cli/parse.js'
import { writeModelExport } from '../packages/cli/src/cli/model-export-command.js'
import { openProductionPluginManagementComposition } from '../packages/cli/src/cli/production-plugin-management.js'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import {
  CompositeCatalogManagement,
  NativeCatalogManagement,
} from '../packages/cli/src/launcher/model-catalog/native-catalog-management.js'
import { codexConfigModelProviders } from '../packages/cli/src/launcher/codex-config-model-providers.js'
import { ManagedCatalogComposition } from '../packages/cli/src/launcher/model-catalog/managed-catalog-composition.js'
import { exportCliModelCatalog } from '../packages/cli/src/launcher/model-catalog/cli-export.js'
import {
  decodePortableBundle,
  encodePortableBundle,
  portableConnection,
} from '../packages/cli/src/launcher/model-catalog/portable-transfer-codec.js'
import type { CatalogManagementView } from '../packages/cli/src/model-catalog-management.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'

const roots: string[] = []
const closes: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(
  options: { inline?: boolean; unsupported?: boolean; count?: number; large?: boolean; withoutVariables?: boolean } =
    {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-model-export-'))
  roots.push(root)
  const codexHome = path.join(root, 'codex')
  await mkdir(codexHome)
  const configPath = path.join(root, 'config.json')
  const home = {
    ...createDefaultHomeConfig(),
    environmentVariables: [{ name: 'TEST_KEY', value: 'saved-user-value', enabled: true }],
    apps: {
      codex: {
        defaultProfile: 'work',
        profiles: {
          work: { displayName: 'Work', dataMode: 'shared', configModelCatalogs: { gateway: 'models.json' } },
        },
      },
    },
  }
  await writeFile(configPath, JSON.stringify(home), { mode: 0o600 })
  await writeFile(path.join(codexHome, 'auth.json'), 'CREDENTIAL_FILE_MUST_NOT_BE_READ', { mode: 0o000 })
  const models = Array.from(
    { length: options.count ?? 2 },
    (_, i) => ({ slug: options.large ? randomBytes(180).toString('hex') : `model-${i}`, display_name: `Model ${i}` }),
  )
  await writeFile(path.join(codexHome, 'models.json'), JSON.stringify({ models }))
  await writeFile(
    path.join(codexHome, 'config.toml'),
    `model_provider = "gateway"\nmodel_catalog_json = "models.json"\n[model_providers.gateway]\nname = "Gateway"\nbase_url = "${
      options.unsupported ? 'http://127.0.0.1:54321' : 'https://api.example.com/v1'
    }"\nwire_api = "responses"\nrequires_openai_auth = false\n${
      options.inline ? 'experimental_bearer_token = "INLINE_PRIVATE_TOKEN"' : 'env_key = "TEST_KEY"'
    }\nhttp_headers = { "X-Private" = "SECRET_HEADER" }\n`,
  )
  const env = { CORDISX_HOME: root, CODEX_HOME: codexHome, TEST_KEY: 'PROCESS_ENV_VALUE' }
  const stdout: string[] = [], stderr: string[] = []
  const runtime = {
    env,
    stdout: (text: string) => stdout.push(text),
    stderr: new Writable({
      write(chunk, _encoding, done) {
        stderr.push(chunk.toString())
        done()
      },
    }),
  }
  const run = async (args: readonly string[]) => {
    stdout.length = 0
    stderr.length = 0
    await runCordisXCli(['model', 'export', ...args], runtime)
    return stdout.join('\n')
  }
  return {
    root,
    configPath,
    codexHome,
    env,
    stdout,
    stderr,
    runtime,
    run,
    models,
    withoutVariables: options.withoutVariables,
  }
}

async function active(f: Awaited<ReturnType<typeof fixture>>, unsupported = false) {
  const native = await NativeCatalogManagement.open({
    load: async () => {
      const projection = await codexConfigModelProviders(f.codexHome, { gateway: 'models.json' })
      return f.withoutVariables
        ? {
          ...projection,
          portableEnvironment: new Map(),
          portableConnections: new Map(
            [...projection.portableConnections ?? []].map((
              [id, connection],
            ) => [id, { endpoint: connection.endpoint, protocol: connection.protocol, auth: connection.auth }]),
          ),
        }
        : projection
    },
  })
  const managed = await ManagedCatalogComposition.open({ homeDir: f.root, profileId: 'work', responsesAvailable: true })
  closes.push(() => managed.close())
  const payload = encodePortableBundle({
    version: 2,
    environment: [{ name: 'TEST_KEY' }],
    connections: [
      portableConnection({
        title: 'Managed',
        endpoint: 'https://managed.example.com/v1',
        protocol: 'responses',
        auth: 'bearer',
        environment: 'TEST_KEY',
        models: [{ id: 'managed-model', label: 'Managed model' }],
      }),
    ],
  })
  await managed.importPortable(decodePortableBundle(payload), [{
    sourceName: 'TEST_KEY',
    name: 'TEST_KEY',
    value: 'saved-user-value',
    enabled: true,
  }], () => true)
  const base = new CompositeCatalogManagement(native, managed)
  closes.push(() => base.close())
  const authority = unsupported
    ? {
      ...Object.create(base),
      snapshot: () => ({
        ...base.snapshot(),
        views: [
          ...base.snapshot().views,
          {
            bindingRef: 'plugin:aiden',
            providerId: 'aiden',
            title: 'Aiden',
            transferAvailable: false,
            rows: [],
          } as unknown as CatalogManagementView,
        ],
      }),
      prepareExport: base.prepareExport.bind(base),
      export: base.export.bind(base),
    }
    : base
  const coordinator = new PluginLifecycleCoordinator({
    homeDir: f.root,
    profileId: 'work',
    runtimeGeneration: 'test-export',
    permissionPolicies: [],
    runtime: {
      stage: async () => undefined,
      commit: async () => undefined,
      abort: async () => undefined,
      reload: async () => undefined,
    },
  })
  const modelExport = vi.fn(async request =>
    exportCliModelCatalog(authority, request, (await loadHomeConfig(f.configPath)).environmentVariables)
  )
  const composition = await openProductionPluginManagementComposition({
    configPath: f.configPath,
    homeDir: f.root,
    appId: 'codex',
    profileId: 'work',
    runtimeGeneration: 'test-export',
    token: 'renderer-test-token',
    coordinator,
    modelExport,
    processStartedAt: await processStartIdentity(process.pid),
  })
  closes.push(() => composition.close())
  return { modelExport, base }
}

function decoded(text: string) {
  return decodePortableBundle(text.trim())
}

describe('CLI portable model export', () => {
  it('routes help and rejects ambiguous, duplicate and unsupported arguments before opening configuration', async () => {
    expect(parseCordisXCli(['model', 'export', '--help'])).toMatchObject({ action: 'model-export', help: true })
    for (
      const args of [
        [],
        ['--all', '--service', 'x'],
        ['--model', 'x'],
        ['--list', '--include-values'],
        ['--all', '--force'],
        ['--service', 'x', '--service', 'x'],
        ['--all=true'],
        ['--service', 'x', '--include-values', '--exclude-values'],
        ['--list', '--exclude-values'],
        ['--all', '--profile', '../bad'],
        ['--all', '--', '--host'],
      ]
    ) expect(() => parseCordisXCli(['model', 'export', ...args])).toThrow()
  })

  it('exports a real offline portable config without values, credentials or writes to the source', async () => {
    const f = await fixture()
    const before = await readFile(f.configPath, 'utf8')
    const result = await f.run([
      '--exclude-values',
      '--service',
      'codex-config:gateway',
      '--model',
      'model-1',
      '--profile',
      'work',
    ])
    const bundle = decoded(result)
    expect(bundle).toMatchObject({
      version: 2,
      environment: [{ name: 'TEST_KEY' }],
      connections: [{ models: [{ id: 'model-1' }] }],
    })
    const json = JSON.stringify(bundle)
    for (
      const secret of [
        'saved-user-value',
        'PROCESS_ENV_VALUE',
        'SECRET_HEADER',
        'CREDENTIAL_FILE_MUST_NOT_BE_READ',
        'credentialRef',
      ]
    ) expect(json).not.toContain(secret)
    expect(await readFile(f.configPath, 'utf8')).toBe(before)
    expect(await readdir(f.root)).not.toContain('state')
    expect(f.stderr.join('')).toContain('Manager > Model services > Import')
    expect(f.stderr.join('')).toContain('WARNING: Variable values were not included: TEST_KEY')
    expect(f.stderr.join('')).toContain('cannot use services requiring these variables')
    for (const secret of ['saved-user-value', 'PROCESS_ENV_VALUE', 'SECRET_HEADER']) {
      expect(f.stderr.join('')).not.toContain(secret)
    }
    expect(f.stdout).toHaveLength(1)
  })

  it('includes only saved enabled user values and keeps inline/private tokens as empty target placeholders', async () => {
    const f = await fixture()
    expect(decoded(await f.run(['--service', 'codex-config:gateway', '--include-values']))).toMatchObject({
      environment: [{ name: 'TEST_KEY', value: 'saved-user-value' }],
    })
    expect(f.stderr.join('')).toContain('UNENCRYPTED')
    expect(f.stderr.join('')).not.toContain('WARNING: Variable values')
    expect(f.stderr.join('')).not.toContain('To re-export')
    const inline = await fixture({ inline: true })
    const bundle = decoded(await inline.run(['--service', 'codex-config:gateway', '--include-values']))
    expect(JSON.stringify(bundle)).not.toContain('INLINE_PRIVATE_TOKEN')
    expect(bundle).toMatchObject({ environment: [{ value: '' }] })
    expect(inline.stderr.join('')).toContain(
      'WARNING: Variable values are still missing after including saved values: CORDISX_MODEL_SERVICE_KEY',
    )
    expect(inline.stderr.join('')).toContain('cannot use services requiring these variables')
    expect(inline.stderr.join('')).not.toContain('To re-export')
    expect(inline.stderr.join('')).not.toContain('INLINE_PRIVATE_TOKEN')
  })

  it('uses the production RPC service for complete lists and native plus managed --all exports', async () => {
    const f = await fixture()
    const { modelExport } = await active(f)
    const list = JSON.parse(await f.run(['--list']))
    expect(list.complete).toBe(true)
    expect(list.services).toHaveLength(2)
    const result = decoded(await f.run(['--exclude-values', '--all']))
    expect(result.connections).toHaveLength(2)
    expect(result.connections.flatMap(connection => connection.models)).toHaveLength(3)
    expect(JSON.stringify(result)).not.toContain('saved-user-value')
    expect(modelExport).toHaveBeenCalledTimes(2)
    expect(f.stderr.join('')).not.toContain('Offline')
    const managedId = list.services.find((service: any) => service.title === 'Managed').bindingRef
    expect(decoded(await f.run(['--service', managedId, '--include-values']))).toMatchObject({
      environment: [{ value: 'saved-user-value' }],
      connections: [{ models: [{ id: 'managed-model' }] }],
    })
  })

  it('rejects unsupported or partial all selection without fallback or an output file', async () => {
    const f = await fixture()
    await active(f, true)
    const file = path.join(f.root, 'export.txt')
    await expect(f.run(['--exclude-values', '--all', '--output', file])).rejects.toThrow(/not portable.*Aiden\/TraeX/u)
    expect(f.stdout).toEqual([])
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.stderr.join('')).not.toContain('Exported')
    const paths = pluginManagementRpcPaths(f.root, 'codex', 'work')
    const endpoint = await readPluginManagementRpcEndpoint(paths)
    await expect(
      requestPluginManagementRpc(paths, { ...endpoint!, token: '0'.repeat(64) }, {
        kind: 'model-export',
        request: { list: true, all: false, services: [], modelIds: [], includeValues: false },
      }),
    ).rejects.toThrow('scope is invalid')
  })

  it('publishes 0600 files atomically, refuses overwrite/symlinks and cleans temporary files', async () => {
    const f = await fixture()
    const file = path.join(f.root, 'models.txt')
    await f.run(['--exclude-values', '--service', 'codex-config:gateway', '--output', file])
    expect(f.stdout).toEqual([])
    expect((await lstat(file)).mode & 0o777).toBe(0o600)
    expect(decoded(await readFile(file, 'utf8')).connections).toHaveLength(1)
    expect(f.stderr.join('')).toContain(file)
    const original = await readFile(file, 'utf8')
    await expect(f.run(['--exclude-values', '--service', 'codex-config:gateway', '--output', file])).rejects.toThrow(
      'Output already exists',
    )
    expect(await readFile(file, 'utf8')).toBe(original)
    await f.run([
      '--exclude-values',
      '--service',
      'codex-config:gateway',
      '--model',
      'model-0',
      '--output',
      file,
      '--force',
    ])
    expect(decoded(await readFile(file, 'utf8')).connections[0]!.models).toHaveLength(1)
    const alias = path.join(f.root, 'alias.txt')
    await symlink(file, alias)
    await expect(writeModelExport(alias, 'bad', true)).rejects.toThrow('regular file')
    expect((await readdir(f.root)).filter(name => name.startsWith('.cordisx-model-export-'))).toEqual([])
    await expect(writeModelExport(path.join(f.root, 'missing', 'output.txt'), 'bad', false)).rejects.toThrow()
  })

  it('labels offline lists incomplete, rejects offline all, unknown models and missing profiles without writing config', async () => {
    const f = await fixture()
    expect(JSON.parse(await f.run(['--list'])).complete).toBe(false)
    for (
      const args of [['--all'], ['--service', 'codex-config:missing'], [
        '--service',
        'codex-config:gateway',
        '--model',
        'missing',
      ], ['--service', 'codex-config:gateway', '--profile', 'missing']]
    ) {
      await expect(f.run(args)).rejects.toThrow()
      expect(f.stdout).toEqual([])
    }
    expect((await loadHomeConfig(f.configPath)).apps.codex?.profiles.missing).toBeUndefined()
  })

  it('refuses runtime local endpoints and oversized portable bundles before publishing', async () => {
    const f = await fixture({ unsupported: true })
    await expect(f.run(['--exclude-values', '--service', 'codex-config:gateway'])).rejects.toThrow('not portable')
    const large = await fixture({ count: 900, large: true })
    const file = path.join(large.root, 'large.txt')
    await expect(large.run(['--exclude-values', '--service', 'codex-config:gateway', '--output', file])).rejects
      .toThrow(/too-large/u)
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(large.stdout).toEqual([])
  })

  it('does not resolve disabled user values from the process environment', async () => {
    const f = await fixture()
    const config = await loadHomeConfig(f.configPath)
    await writeFile(
      f.configPath,
      JSON.stringify({
        ...config,
        environmentVariables: [{ name: 'TEST_KEY', value: 'disabled-secret', enabled: false }],
      }),
      { mode: 0o600 },
    )
    const bundle = decoded(await f.run(['--service', 'codex-config:gateway', '--include-values']))
    expect(bundle).toMatchObject({ environment: [{ name: 'TEST_KEY', value: '' }] })
    expect(JSON.stringify(bundle)).not.toContain('PROCESS_ENV_VALUE')
    expect(f.stderr.join('')).toContain(
      'WARNING: Variable values are still missing after including saved values: TEST_KEY',
    )
    expect(f.stderr.join('')).not.toContain('disabled-secret')
  })

  it('rejects partial authority output and bundle connection overflow', async () => {
    const f = await fixture()
    const native = await NativeCatalogManagement.open({
      load: () => codexConfigModelProviders(f.codexHome, { gateway: 'models.json' }),
    })
    const base = new CompositeCatalogManagement(native)
    closes.push(() => base.close())
    const request = { list: false, all: true, services: [], modelIds: [], includeValues: false }
    const partial = await exportCliModelCatalog(base, {
      ...request,
      all: false,
      services: ['codex-config:gateway'],
      modelIds: ['model-0'],
    }, [])
    expect(partial.kind).toBe('export')
    const exportPartial = vi.fn(async () => ({
      status: 'ok' as const,
      text: partial.kind === 'export' ? partial.text : '',
    }))
    await expect(
      exportCliModelCatalog(
        { snapshot: () => base.snapshot(), prepareExport: base.prepareExport.bind(base), export: exportPartial },
        request,
        [],
      ),
    ).rejects.toThrow('Incomplete model export')
    const snapshot = base.snapshot()
    const tooMany = {
      ...snapshot,
      views: Array.from({ length: 25 }, (_, i) => ({ ...snapshot.views[0]!, bindingRef: `config:${i}` })),
    }
    await expect(
      exportCliModelCatalog(
        { snapshot: () => tooMany, prepareExport: base.prepareExport.bind(base), export: exportPartial },
        request,
        [],
      ),
    ).rejects.toThrow('at most 24')
    expect(exportPartial).toHaveBeenCalledOnce()
  })

  it('fails a live unavailable runtime without falling back to an exportable offline config', async () => {
    const f = await fixture()
    const native = await NativeCatalogManagement.open({
      load: () => codexConfigModelProviders(f.codexHome, { gateway: 'models.json' }),
    })
    const base = new CompositeCatalogManagement(native)
    closes.push(() => base.close())
    const coordinator = new PluginLifecycleCoordinator({
      homeDir: f.root,
      profileId: 'work',
      runtimeGeneration: 'test-unavailable',
      permissionPolicies: [],
      runtime: {
        stage: async () => undefined,
        commit: async () => undefined,
        abort: async () => undefined,
        reload: async () => undefined,
      },
    })
    const composition = await openProductionPluginManagementComposition({
      configPath: f.configPath,
      homeDir: f.root,
      appId: 'codex',
      profileId: 'work',
      runtimeGeneration: 'test-unavailable',
      token: 'renderer-test-token',
      coordinator,
      processStartedAt: await processStartIdentity(process.pid),
    })
    closes.push(() => composition.close())
    await expect(f.run(['--exclude-values', '--service', 'codex-config:gateway'])).rejects.toThrow(
      'Model export unavailable',
    )
    expect(f.stdout).toEqual([])
    expect(f.stderr.join('')).not.toContain('Exported')
  })

  it('adds no missing-variable warning or retry suggestion for a portable bundle without variables', async () => {
    const f = await fixture({ withoutVariables: true })
    await active(f)
    const bundle = decoded(await f.run(['--service', 'codex-config:gateway']))
    expect(bundle.version).toBe(1)
    expect(f.stdout).toHaveLength(1)
    expect(f.stderr.join('')).not.toContain('WARNING: Variable values')
    expect(f.stderr.join('')).not.toContain('--include-values')
    expect(f.stderr.join('')).not.toContain('To re-export')
  })

  it('returns safe structured choice-required without generating portable text or touching the output file', async () => {
    const f = await fixture()
    const { base } = await active(f)
    const generate = vi.spyOn(base, 'export')
    const file = path.join(f.root, 'choice.txt')
    await expect(runCordisXCli(['model', 'export', '--service', 'codex-config:gateway', '--output', file], f.runtime))
      .rejects.toMatchObject({ code: 'choice-required', exitCode: 2 })
    const choice = JSON.parse(f.stderr.join(''))
    expect(choice).toMatchObject({
      status: 'choice-required',
      profileId: 'work',
      variables: ['TEST_KEY'],
      choices: [{ key: 'A', flag: '--include-values' }, { key: 'B', flag: '--exclude-values' }],
    })
    expect(f.stdout).toEqual([])
    expect(generate).not.toHaveBeenCalled()
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const secret of ['saved-user-value', 'PROCESS_ENV_VALUE', 'SECRET_HEADER']) {
      expect(f.stderr.join('')).not.toContain(secret)
    }
  })

  it.each(['A', 'B'])(
    'asks before output and generates exactly one final export after terminal choice %s',
    async choice => {
      const f = await fixture()
      const { base } = await active(f)
      const generate = vi.spyOn(base, 'export')
      const input = new PassThrough()
      Object.defineProperty(input, 'isTTY', { value: true })
      const file = path.join(f.root, 'choice.txt')
      const pending = runCordisXCli([
        'model',
        'export',
        '--service',
        'codex-config:gateway',
        '--model',
        'model-1',
        '--output',
        file,
      ], { ...f.runtime, stdin: input, internalModelExportStdoutIsTTY: true })
      await vi.waitFor(() => expect(f.stderr.join('')).toContain('Choose A or B'))
      expect(generate).not.toHaveBeenCalled()
      expect(f.stdout).toEqual([])
      await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
      input.end(`${choice}\n`)
      await pending
      expect(generate).toHaveBeenCalledOnce()
      const bundle = decoded(await readFile(file, 'utf8'))
      expect(bundle).toMatchObject({
        environment: [choice === 'A' ? { name: 'TEST_KEY', value: 'saved-user-value' } : { name: 'TEST_KEY' }],
        connections: [{ models: [{ id: 'model-1' }] }],
      })
      if (choice === 'B') expect(JSON.stringify(bundle)).not.toContain('saved-user-value')
      expect(f.stderr.join('')).toContain('UNENCRYPTED')
      expect(f.stderr.join('')).not.toContain('saved-user-value')
      expect((await readdir(f.root)).filter(name => name.endsWith('.with-values'))).toEqual([])
      expect(f.stdout).toEqual([])
    },
  )

  it('rejects changed variable dependencies after a terminal choice before final generation', async () => {
    const f = await fixture()
    const { base } = await active(f)
    const prepare = base.prepareExport.bind(base)
    let changed = false
    vi.spyOn(base, 'prepareExport').mockImplementation((request, authorized) => {
      const result = prepare(request, authorized)
      return changed && result.status === 'ok'
        ? { ...result, variables: result.variables.map(variable => ({ ...variable, sourceName: 'CHANGED_KEY' })) }
        : result
    })
    const generate = vi.spyOn(base, 'export')
    const input = new PassThrough()
    Object.defineProperty(input, 'isTTY', { value: true })
    const file = path.join(f.root, 'changed.txt')
    const pending = runCordisXCli(['model', 'export', '--service', 'codex-config:gateway', '--output', file], {
      ...f.runtime,
      stdin: input,
      internalModelExportStdoutIsTTY: true,
    }).then(() => undefined, error => error)
    await vi.waitFor(() => expect(f.stderr.join('')).toContain('Choose A or B'))
    changed = true
    input.end('A\n')
    expect((await pending).message).toContain('Variable dependencies changed')
    expect(generate).not.toHaveBeenCalled()
    expect(f.stdout).toEqual([])
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['--include-values', '--exclude-values'])(
    'respects explicit %s without a terminal prompt and keeps stdout portable',
    async flag => {
      const f = await fixture()
      const input = new PassThrough()
      Object.defineProperty(input, 'isTTY', { value: true })
      await runCordisXCli(['model', 'export', '--service', 'codex-config:gateway', flag, '--output', '-'], {
        ...f.runtime,
        stdin: input,
        internalModelExportStdoutIsTTY: true,
      })
      expect(f.stdout).toHaveLength(1)
      expect(decoded(f.stdout[0]!).connections).toHaveLength(1)
      expect(f.stderr.join('')).not.toContain('Choose A or B')
      input.destroy()
    },
  )

  it.each(['Q\n', '', 'yes\n'])('cancels safely on cancellation, EOF or invalid input %j', async answer => {
    const f = await fixture()
    const input = new PassThrough()
    Object.defineProperty(input, 'isTTY', { value: true })
    const file = path.join(f.root, 'cancel.txt')
    const pending = runCordisXCli(['model', 'export', '--service', 'codex-config:gateway', '--output', file], {
      ...f.runtime,
      stdin: input,
      internalModelExportStdoutIsTTY: true,
    }).then(() => undefined, error => error)
    await vi.waitFor(() => expect(f.stderr.join('')).toContain('Choose A or B'))
    input.end(answer)
    expect(await pending).toMatchObject({ code: answer === 'yes\n' ? 'invalid-choice' : 'cancelled' })
    expect(f.stdout).toEqual([])
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not wait on a terminal stdin when stdout is a pipe', async () => {
    const f = await fixture()
    const input = new PassThrough()
    Object.defineProperty(input, 'isTTY', { value: true })
    await expect(
      runCordisXCli(['model', 'export', '--service', 'codex-config:gateway'], {
        ...f.runtime,
        stdin: input,
        internalModelExportStdoutIsTTY: false,
      }),
    ).rejects.toMatchObject({ code: 'choice-required' })
    expect(JSON.parse(f.stderr.join('')).status).toBe('choice-required')
    expect(f.stdout).toEqual([])
    input.destroy()
  })

  it('binds the export callback through production run assembly without starting a native process', async () => {
    const f = await fixture()
    const native = await NativeCatalogManagement.open({
      load: () => codexConfigModelProviders(f.codexHome, { gateway: 'models.json' }),
    })
    const base = new CompositeCatalogManagement(native)
    const modelExport = vi.fn(async request =>
      exportCliModelCatalog(base, request, (await loadHomeConfig(f.configPath)).environmentVariables)
    )
    const close = vi.fn(async () => base.close())
    await runCordisXCli(['run', 'codex', 'work', '--executable', process.execPath], {
      ...f.runtime,
      internalNativeSubmissionPlatform: 'darwin',
      internalBuildRendererBundle: async () => 'fixture-renderer',
      internalSharedHomeDir: path.join(f.root, 'shared-host-home'),
      internalCreateNativeSubmissionComposition: async () => ({
        installation: { authority: {} as any, transforms: [] },
        environment: {},
        modelExport,
        close,
      }),
      internalRunInjectedHost: async () => {
        const result = decoded(await f.run(['--exclude-values', '--all']))
        expect(result.connections[0]!.models).toHaveLength(2)
        expect(modelExport).toHaveBeenCalledOnce()
      },
    })
    expect(close).toHaveBeenCalledOnce()
    await expect(lstat(pluginManagementRpcPaths(f.root, 'codex', 'work').state)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('keeps packaged CLI stdout machine-readable and errors nonzero on stderr', async () => {
    const f = await fixture()
    const cli = path.resolve('packages/cli/dist/src/cli.js')
    const result = spawnSync(process.execPath, [
      cli,
      'model',
      'export',
      '--exclude-values',
      '--service',
      'codex-config:gateway',
    ], {
      env: { ...process.env, ...f.env },
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(decoded(result.stdout).connections).toHaveLength(1)
    expect(result.stderr).toContain('Manager > Model services > Import')
    const failed = spawnSync(process.execPath, [cli, 'model', 'export', '--all'], {
      env: { ...process.env, ...f.env },
      encoding: 'utf8',
    })
    expect(failed.status).not.toBe(0)
    expect(failed.stdout).toBe('')
    expect(failed.stderr).toContain('incomplete')
    const choice = spawnSync(process.execPath, [
      cli,
      'model',
      'export',
      '--service',
      'codex-config:gateway',
      '--output',
      path.join(f.root, 'not-created.txt'),
    ], { env: { ...process.env, ...f.env }, encoding: 'utf8' })
    expect(choice.status).toBe(2)
    expect(choice.stdout).toBe('')
    expect(JSON.parse(choice.stderr.split('\n').find(line => line.startsWith('{'))!).status).toBe('choice-required')
    await expect(lstat(path.join(f.root, 'not-created.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
