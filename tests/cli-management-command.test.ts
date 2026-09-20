import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'
import { CordisXManagementCommandError } from '../packages/cli/src/cli/management-command.js'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import type {
  PluginManagementRequest,
  PluginManagementResult,
  PluginManagementSnapshot,
} from '../packages/cli/src/management/contracts.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'

const roots: string[] = []

async function home(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-management-cli-'))
  roots.push(root)
  await ensureHomeConfig(path.join(root, 'config.json'))
  return root
}

const snapshot: PluginManagementSnapshot = {
  profileId: 'default',
  revision: 7,
  sources: [{
    url: 'https://plugins.example/catalog.json',
    enabled: true,
    trusted: true,
    official: false,
    removable: true,
    local: { name: 'Example', description: 'Old description' },
  }],
  hiddenCatalogEntries: [{
    sourceUrl: 'https://plugins.example/catalog.json',
    pluginId: 'com.example.calendar',
  }],
  migrations: { legacyBrowserSourcesV2: false },
  runtime: { kind: 'inactive', pendingActivation: false },
  activationRevision: 3,
  plugins: [],
}

function service(overrides: Partial<PluginManagementService> = {}): PluginManagementService {
  return {
    query: vi.fn(async () => snapshot),
    refreshCatalog: vi.fn(async () => ({ refreshedAt: '2026-09-19T00:00:00.000Z', sources: [], plugins: [] })),
    queryCatalog: vi.fn(async () => []),
    pluginInfo: vi.fn(async () => undefined),
    plan: vi.fn(async request => ({ status: 'planned', request, snapshot, executionRequest: request })),
    execute: vi.fn(async request => ({ status: 'applied', request, snapshot, pendingActivation: false })),
    migrateLegacySources: vi.fn(async () => ({ migrated: false, clearLegacyStorage: true, snapshot })),
    subscribe: vi.fn(() => () => {}),
    close: vi.fn(),
    ...overrides,
  }
}

async function runWithService(
  args: readonly string[],
  management: PluginManagementService,
  options: { readonly confirm?: boolean; readonly stdout?: string[] } = {},
): Promise<void> {
  const root = await home()
  await runCordisXCli(args, {
    env: { CORDISX_HOME: root },
    stdout: line => options.stdout?.push(line),
    internalManagementConfirm: options.confirm === undefined ? undefined : async () => options.confirm!,
    internalOpenPluginManagementService: async () => management,
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('management CLI commands', () => {
  it('does not create a home or profile during a real-service dry run', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'cordisx-management-cli-parent-'))
    roots.push(parent)
    const root = path.join(parent, 'missing-home')
    await runCordisXCli([
      'source',
      'add',
      'https://plugins.example/catalog.json',
      '--profile',
      'work',
      '--dry-run',
      '--yes',
    ], { env: { CORDISX_HOME: root }, stdout: () => undefined })
    await expect(import('node:fs/promises').then(({ stat }) => stat(root))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('executes the exact opaque request returned by plan', async () => {
    const executionRequest = { kind: 'plugin-execute-plan', executionToken: 'opaque-token' } as const
    const confirm = vi.fn(async () => true)
    const management = service({
      plan: vi.fn(async request => ({
        status: 'planned',
        request,
        snapshot,
        executionRequest,
        affectedPluginIds: ['com.example.calendar', 'com.example.agenda'],
      })),
    })
    const root = await home()
    await runCordisXCli(['plugin', 'disable', 'com.example.calendar'], {
      env: { CORDISX_HOME: root },
      stdout: () => undefined,
      internalManagementConfirm: confirm,
      internalOpenPluginManagementService: async () => management,
    })
    expect(confirm).toHaveBeenCalledWith(
      'Apply cordisx plugin disable for com.example.calendar? This also affects: com.example.calendar, com.example.agenda.',
    )
    expect(management.execute).toHaveBeenCalledWith(executionRequest, snapshot.revision)
    expect(management.close).toHaveBeenCalledOnce()
  })

  it('stops after a declined confirmation', async () => {
    const management = service()
    const output: string[] = []
    await runWithService(['plugin', 'disable', 'com.example.calendar'], management, { confirm: false, stdout: output })
    expect(management.execute).not.toHaveBeenCalled()
    expect(output).toEqual(['Cancelled; no management change was applied.'])
  })

  it('uses persisted hidden identities for unhide without loading the catalog', async () => {
    const management = service()
    await runWithService([
      'plugin',
      'unhide',
      'com.example.calendar',
      '--source',
      'https://plugins.example/catalog.json',
      '--yes',
    ], management)
    expect(management.pluginInfo).not.toHaveBeenCalled()
    expect(management.plan).toHaveBeenCalledWith({
      kind: 'catalog-unhide',
      identity: snapshot.hiddenCatalogEntries[0],
    })
  })

  it('resolves a Host-owned source name for queries and installs while preserving URL selectors', async () => {
    const management = service()
    await runWithService(['plugin', 'search', 'alpha', '--source', 'Example'], management)
    expect(management.queryCatalog).toHaveBeenCalledWith({ query: 'alpha', sourceUrl: snapshot.sources[0]!.url })
    await runWithService(['plugin', 'install', 'alpha', '--source', 'Example', '--yes'], management)
    expect(management.plan).toHaveBeenLastCalledWith({
      kind: 'plugin-plan-marketplace',
      pluginId: 'alpha',
      sourceUrl: snapshot.sources[0]!.url,
    })

    await runWithService(['plugin', 'install', 'beta', '--source', 'Example', '--yes'], management)
    expect(management.plan).toHaveBeenLastCalledWith({
      kind: 'plugin-plan-marketplace',
      pluginId: 'beta',
      sourceUrl: snapshot.sources[0]!.url,
    })

    await runWithService([
      'plugin',
      'install',
      'alpha',
      '--source',
      snapshot.sources[0]!.url,
      '--yes',
    ], management)
    expect(management.plan).toHaveBeenLastCalledWith({
      kind: 'plugin-plan-marketplace',
      pluginId: 'alpha',
      sourceUrl: snapshot.sources[0]!.url,
    })
  })

  it('supports the add-name then install-by-name workflow for multiple plugins', async () => {
    const sourceUrl = 'https://plugins.example/team.json'
    let current = { ...snapshot, sources: [] as PluginManagementSnapshot['sources'] }
    const management = service({
      query: vi.fn(async () => current),
      plan: vi.fn(async request => ({ status: 'planned', request, snapshot: current, executionRequest: request })),
      execute: vi.fn(async request => {
        if (request.kind === 'source-add') {
          current = {
            ...current,
            sources: [{
              ...request.source,
              trusted: request.source.trusted === true,
              official: false,
              removable: true,
            }],
          }
        }
        return { status: 'applied', request, snapshot: current, pendingActivation: false }
      }),
    })
    await runWithService(['source', 'add', sourceUrl, '--name', 'team', '--yes'], management)
    expect(management.plan).toHaveBeenLastCalledWith({
      kind: 'source-add',
      source: { url: sourceUrl, enabled: true, trusted: true, local: { name: 'team' } },
    })
    await runWithService(['plugin', 'install', 'alpha', '--source', 'team', '--yes'], management)
    await runWithService(['plugin', 'install', 'beta', '--source', 'team', '--yes'], management)
    expect(management.plan).toHaveBeenNthCalledWith(2, {
      kind: 'plugin-plan-marketplace',
      pluginId: 'alpha',
      sourceUrl,
    })
    expect(management.plan).toHaveBeenNthCalledWith(3, {
      kind: 'plugin-plan-marketplace',
      pluginId: 'beta',
      sourceUrl,
    })
  })

  it.each([
    'http://127.0.0.1:43124/catalog.json',
    'https://plugins.example/catalog.json?channel=team',
  ])('adds discovery-only source %s as untrusted by default', async sourceUrl => {
    const management = service()
    await runWithService(['source', 'add', sourceUrl, '--yes'], management)
    expect(management.plan).toHaveBeenLastCalledWith({
      kind: 'source-add',
      source: { url: sourceUrl, enabled: true, trusted: false },
    })
  })

  it('still rejects explicit trust for a discovery-only source URL', async () => {
    const management = service()
    await expect(runWithService([
      'source',
      'add',
      'https://plugins.example/catalog.json?channel=team',
      '--trusted',
      '--yes',
    ], management)).rejects.toThrow('must be HTTPS without a query when trusted')
  })

  it('rejects missing, disabled, and duplicate source names without guessing', async () => {
    const disabled = service({
      query: vi.fn(async () => ({
        ...snapshot,
        sources: [{ ...snapshot.sources[0]!, enabled: false, local: { name: 'team' } }],
      })),
    })
    await expect(runWithService(['plugin', 'install', 'alpha', '--source', 'team', '--yes'], disabled))
      .rejects.toMatchObject({ code: 'source-disabled' })

    const duplicate = service({
      query: vi.fn(async () => ({
        ...snapshot,
        sources: [
          { ...snapshot.sources[0]!, local: { name: 'team' } },
          {
            ...snapshot.sources[0]!,
            url: 'https://other.example/marketplace.json',
            local: { name: 'team' },
          },
        ],
      })),
    })
    await expect(runWithService(['plugin', 'info', 'beta', '--source', 'team'], duplicate))
      .rejects.toMatchObject({ code: 'ambiguous-selection' })

    await expect(runWithService(['plugin', 'search', 'alpha', '--source', 'missing'], service()))
      .rejects.toMatchObject({ code: 'not-found' })
  })

  it('preserves source fields while editing and omits cleared local metadata', async () => {
    const management = service()
    await runWithService([
      'source',
      'edit',
      'https://plugins.example/catalog.json',
      '--name',
      '',
      '--description',
      '',
      '--yes',
    ], management)
    expect(management.plan).toHaveBeenCalledWith({
      kind: 'source-edit',
      url: 'https://plugins.example/catalog.json',
      source: {
        url: 'https://plugins.example/catalog.json',
        enabled: true,
        trusted: true,
      },
    })
  })

  it('refreshes only the selected canonical source', async () => {
    const management = service()
    await runWithService([
      'source',
      'refresh',
      'https://plugins.example/catalog.json',
    ], management)
    expect(management.refreshCatalog).toHaveBeenCalledWith('https://plugins.example/catalog.json')
  })

  it('reports permission review as JSON and a nonzero script status', async () => {
    const request: PluginManagementRequest = { kind: 'plugin-disable', pluginId: 'com.example.calendar' }
    const permissionResult: PluginManagementResult = {
      status: 'permission-review-required',
      request,
      snapshot,
      candidateId: 'candidate-1',
      permissionPlan: {
        schemaVersion: 1,
        requestId: 'review-1',
        profileId: 'default',
        runtimeGeneration: 'generation-1',
        expectedRevision: 3,
        pluginId: 'com.example.calendar',
        declarations: [],
      },
    }
    const management = service({
      plan: vi.fn(async () => permissionResult),
    })
    const output: string[] = []
    await expect(runWithService(
      [
        'plugin',
        'disable',
        'com.example.calendar',
        '--yes',
        '--json',
      ],
      management,
      { stdout: output },
    )).rejects.toMatchObject(
      {
        code: 'permission-review-required',
        exitCode: 2,
        reported: true,
      } satisfies Partial<CordisXManagementCommandError>,
    )
    expect(output.map(line => JSON.parse(line))).toEqual([permissionResult])
    expect(management.execute).not.toHaveBeenCalled()
    expect(management.close).toHaveBeenCalledOnce()
  })

  it('emits one JSON error record and closes the service on failure', async () => {
    const management = service({
      queryCatalog: vi.fn(async () => {
        throw new Error('catalog unavailable')
      }),
    })
    const output: string[] = []
    await expect(runWithService(['plugin', 'search', 'calendar', '--json'], management, { stdout: output }))
      .rejects.toMatchObject({ exitCode: 1, reported: true })
    expect(output.map(line => JSON.parse(line))).toEqual([{
      status: 'error',
      error: { code: 'management-command-failed', message: 'catalog unavailable' },
    }])
    expect(management.close).toHaveBeenCalledOnce()
  })

  it('reports parse failures as JSON with a nonzero process status', async () => {
    const root = await home()
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'packages/cli/src/cli.ts', 'plugin', 'list', '--unknown', '--json'],
      {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, CORDISX_HOME: root, NODE_NO_WARNINGS: '1' },
        encoding: 'utf8',
      },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'error',
      error: {
        code: 'unknown-option',
        message: 'unknown CordisX management option: --unknown',
      },
    })
  })
})
