import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  providerSyncAdapterCapabilities,
  type ProviderSyncBindingDefinition,
  type ProviderSyncConnectionDefinition,
  type ProviderSyncTargetProfileRef,
} from '../packages/cli/src/launcher/provider-profile-sync-contracts.js'
import {
  discoverCodexNativeConnections,
  discoverCodexProviderProfile,
  providerSyncCredentialEnvironmentKey,
  readCodexProviderProfile,
  syncCodexProviderProfile,
} from '../packages/cli/src/launcher/provider-profile-sync-codex.js'
import {
  adoptProviderBinding,
  bindProviderConnection,
  createProviderSyncId,
  importNativeProviderConnection,
  ProviderProfileSyncLedgerStore,
  setProviderBindingState,
} from '../packages/cli/src/launcher/provider-profile-sync-ledger.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `cordisx-provider-sync-${name}-`))
  roots.push(root)
  const codexHome = path.join(root, 'codex-home')
  const stateDir = path.join(root, 'state')
  await mkdir(codexHome, { recursive: true })
  const targetProfileRef: ProviderSyncTargetProfileRef = {
    adapterId: 'codex',
    hostInstanceId: 'codex-fixture',
    profileId: 'work',
    configRoot: codexHome,
  }
  return { root, codexHome, stateDir, targetProfileRef, configPath: path.join(codexHome, 'config.toml') }
}

function connection(input: Partial<ProviderSyncConnectionDefinition> = {}): ProviderSyncConnectionDefinition {
  return {
    connectionId: 'cx-connection-0123456789abcdef',
    revision: 'source-1',
    title: 'Managed Work',
    endpoint: 'https://gateway.example.test/v1',
    protocol: 'responses',
    credential: { secretRef: 'keychain:managed-work', revision: 'credential-1' },
    models: { ids: ['shared-model'], completeness: 'complete' },
    enabled: true,
    ...input,
  }
}

function binding(
  targetProfileRef: ProviderSyncTargetProfileRef,
  input: Partial<ProviderSyncBindingDefinition> = {},
): ProviderSyncBindingDefinition {
  return {
    bindingId: 'cx-binding-0123456789abcdef',
    connectionId: 'cx-connection-0123456789abcdef',
    targetProfileRef,
    localProviderId: 'cordisx-work',
    enabled: true,
    credentialDelivery: 'process-env',
    ...input,
  }
}

describe('provider profile synchronization', () => {
  it('discovers native providers without writing or importing them', async () => {
    const f = await fixture('native')
    const source = [
      '# user-owned connection',
      'model_provider = "native-work"',
      'model = "model-x"',
      '',
      '[model_providers.native-work]',
      'name = "Native Work"',
      'base_url = "https://native.example.test/v1"',
      'wire_api = "responses"',
      'env_key = "NATIVE_WORK_KEY"',
      '',
    ].join('\n')
    await writeFile(f.configPath, source)
    const before = await stat(f.configPath)

    const [providers, projection] = await Promise.all([
      discoverCodexNativeConnections(f.targetProfileRef),
      discoverCodexProviderProfile(f.targetProfileRef),
    ])

    expect(providers).toEqual([expect.objectContaining({
      sourceKind: 'native',
      nativeLocalId: 'native-work',
      title: 'Native Work',
      endpoint: 'https://native.example.test/v1',
      protocol: 'responses',
      credential: { kind: 'environment', reference: 'NATIVE_WORK_KEY' },
      activeModelId: 'model-x',
    })])
    expect(projection.providers[0]).toMatchObject({ owner: 'native', localProviderId: 'native-work' })
    expect(await readFile(f.configPath, 'utf8')).toBe(source)
    expect((await stat(f.configPath)).mtimeMs).toBe(before.mtimeMs)
    await expect(readFile(path.join(f.stateDir, 'provider-profile-bindings.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('creates one stable managed binding and is a zero-write no-op on repeated startup', async () => {
    const f = await fixture('idempotent')
    const source = '# preserved root comment\nmodel = "native-default"\n'
    await writeFile(f.configPath, source)
    const definition = connection()
    const targetBinding = binding(f.targetProfileRef)

    const first = await syncCodexProviderProfile({
      stateDir: f.stateDir,
      targetProfileRef: f.targetProfileRef,
      connections: [definition],
      bindings: [targetBinding],
    })
    const firstConfig = await readFile(f.configPath, 'utf8')
    const firstStat = await stat(f.configPath)
    const firstLedger = await readFile(path.join(f.stateDir, 'provider-profile-bindings.json'), 'utf8')
    await new Promise(resolve => setTimeout(resolve, 10))
    const second = await syncCodexProviderProfile({
      stateDir: f.stateDir,
      targetProfileRef: f.targetProfileRef,
      connections: [definition],
      bindings: [targetBinding],
    })

    expect(first).toMatchObject({ targetChanged: true, ledgerChanged: true })
    expect(second).toMatchObject({ targetChanged: false, ledgerChanged: false, diagnostics: [] })
    expect(await readFile(f.configPath, 'utf8')).toBe(firstConfig)
    expect((await stat(f.configPath)).mtimeMs).toBe(firstStat.mtimeMs)
    expect(await readFile(path.join(f.stateDir, 'provider-profile-bindings.json'), 'utf8')).toBe(firstLedger)
    expect(firstConfig).toContain('# preserved root comment')
    expect(firstConfig).toContain('[model_providers.cordisx-work]')
    expect(firstConfig).toContain(`env_key = "${providerSyncCredentialEnvironmentKey(targetBinding.bindingId)}"`)
    expect(firstConfig).not.toContain('keychain:managed-work')
  })

  it('keeps same-model connections separate by stable identity and credentials', async () => {
    const f = await fixture('accounts')
    const secondConnection = connection({
      connectionId: 'cx-connection-fedcba9876543210',
      credential: { secretRef: 'keychain:second', revision: 'credential-2' },
      title: 'Managed Personal',
    })
    const secondBinding = binding(f.targetProfileRef, {
      bindingId: 'cx-binding-fedcba9876543210',
      connectionId: secondConnection.connectionId,
      localProviderId: 'cordisx-personal',
    })

    const result = await syncCodexProviderProfile({
      stateDir: f.stateDir,
      targetProfileRef: f.targetProfileRef,
      connections: [connection(), secondConnection],
      bindings: [binding(f.targetProfileRef), secondBinding],
    })
    const raw = await readFile(f.configPath, 'utf8')

    expect(result.projection.providers.map(provider => [provider.connectionId, provider.localProviderId])).toEqual([
      ['cx-connection-0123456789abcdef', 'cordisx-work'],
      ['cx-connection-fedcba9876543210', 'cordisx-personal'],
    ])
    expect(raw).toContain(providerSyncCredentialEnvironmentKey('cx-binding-0123456789abcdef'))
    expect(raw).toContain(providerSyncCredentialEnvironmentKey('cx-binding-fedcba9876543210'))
    expect(raw).not.toContain('keychain:managed-work')
    expect(raw).not.toContain('keychain:second')
  })

  it('preserves a conflicting routing group while applying independent display and connection updates', async () => {
    const f = await fixture('conflict')
    const firstBinding = binding(f.targetProfileRef)
    await syncCodexProviderProfile({
      stateDir: f.stateDir,
      targetProfileRef: f.targetProfileRef,
      connections: [connection()],
      bindings: [firstBinding],
    })
    const userEdited = (await readFile(f.configPath, 'utf8'))
      .replace('base_url = "https://gateway.example.test/v1"', 'base_url = "https://user.example.test/v1"')
    await writeFile(f.configPath, userEdited)
    const secondConnection = connection({
      connectionId: 'cx-connection-fedcba9876543210',
      title: 'Independent',
      endpoint: 'https://independent.example.test/v1',
      credential: { secretRef: 'keychain:independent', revision: 'credential-2' },
    })
    const nextSource = connection({
      revision: 'source-2',
      title: 'Renamed managed title',
      endpoint: 'https://source.example.test/v2',
    })
    const secondBinding = binding(f.targetProfileRef, {
      bindingId: 'cx-binding-fedcba9876543210',
      connectionId: secondConnection.connectionId,
      localProviderId: 'cordisx-independent',
    })

    const first = await syncCodexProviderProfile({
      stateDir: f.stateDir,
      targetProfileRef: f.targetProfileRef,
      connections: [nextSource, secondConnection],
      bindings: [firstBinding, secondBinding],
    })
    const firstRaw = await readFile(f.configPath, 'utf8')
    const repeated = await syncCodexProviderProfile({
      stateDir: f.stateDir,
      targetProfileRef: f.targetProfileRef,
      connections: [nextSource, secondConnection],
      bindings: [firstBinding, secondBinding],
    })

    expect(firstRaw).toContain('base_url = "https://user.example.test/v1"')
    expect(firstRaw).not.toContain('https://source.example.test/v2')
    expect(firstRaw).toContain('name = "Renamed managed title"')
    expect(firstRaw).toContain('[model_providers.cordisx-independent]')
    expect(first.diagnostics).toEqual([expect.objectContaining({
      code: 'route-conflict',
      fieldGroup: 'routing',
      notify: true,
    })])
    expect(first.projection.providers.find(provider => provider.localProviderId === 'cordisx-work')).toMatchObject({
      endpoint: 'https://user.example.test/v1',
      sync: { applied: false, skippedGroups: ['routing'] },
    })
    expect(repeated.diagnostics).toEqual([expect.objectContaining({
      code: 'route-conflict',
      fieldGroup: 'routing',
      notify: false,
    })])
    expect(repeated.targetChanged).toBe(false)
  })

  it('keeps a display-only conflict usable when the committed routing group still matches', async () => {
    const f = await fixture('display-conflict')
    const targetBinding = binding(f.targetProfileRef)
    await syncCodexProviderProfile({
      stateDir: f.stateDir,
      targetProfileRef: f.targetProfileRef,
      connections: [connection()],
      bindings: [targetBinding],
    })
    await writeFile(
      f.configPath,
      (await readFile(f.configPath, 'utf8')).replace('name = "Managed Work"', 'name = "User title"'),
    )

    const result = await syncCodexProviderProfile({
      stateDir: f.stateDir,
      targetProfileRef: f.targetProfileRef,
      connections: [connection({ revision: 'source-2', title: 'Source title' })],
      bindings: [targetBinding],
    })

    expect(await readFile(f.configPath, 'utf8')).toContain('name = "User title"')
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: 'route-conflict',
      fieldGroup: 'display',
    })])
    expect(result.projection.providers[0]).toMatchObject({
      title: 'User title',
      sync: { applied: true, skippedGroups: ['display'] },
    })
  })

  it('preserves comments, unknown fields, native providers, and dynamic catalog paths', async () => {
    const f = await fixture('comments')
    const source = [
      '# exact user comment',
      'model_catalog_json = "catalogs/live.json" # dynamic catalog stays',
      '',
      '[model_providers.native]',
      'name = "Native"',
      'base_url = "https://native.example.test/v1"',
      'custom_behavior = "keep" # unknown native field',
      '',
      '[mcp_servers.private]',
      'command = "keep-me"',
      '',
    ].join('\n')
    await writeFile(f.configPath, source)

    await syncCodexProviderProfile({
      stateDir: f.stateDir,
      targetProfileRef: f.targetProfileRef,
      connections: [connection()],
      bindings: [binding(f.targetProfileRef)],
    })
    const raw = await readFile(f.configPath, 'utf8')

    expect(raw).toContain('# exact user comment')
    expect(raw).toContain('model_catalog_json = "catalogs/live.json" # dynamic catalog stays')
    expect(raw).toContain('custom_behavior = "keep" # unknown native field')
    expect(raw).toContain('[mcp_servers.private]\ncommand = "keep-me"')
    expect(raw).toContain('[model_providers.native]')
  })

  it('fences an editor race and leaves the externally written target intact', async () => {
    const f = await fixture('cas')
    await writeFile(f.configPath, '# before\n')

    const result = await syncCodexProviderProfile({
      stateDir: f.stateDir,
      targetProfileRef: f.targetProfileRef,
      connections: [connection()],
      bindings: [binding(f.targetProfileRef)],
      beforeCommit: async () => await writeFile(f.configPath, '# editor won\n'),
    })

    expect(result).toMatchObject({ targetChanged: false, ledgerChanged: false })
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'concurrent-edit' }))
    expect(await readFile(f.configPath, 'utf8')).toBe('# editor won\n')
  })

  it('recovers a target commit whose ledger commit was interrupted', async () => {
    const f = await fixture('recovery')
    const crash = vi.fn(() => {
      throw new Error('fixture crash after target commit')
    })
    await expect(syncCodexProviderProfile({
      stateDir: f.stateDir,
      targetProfileRef: f.targetProfileRef,
      connections: [connection()],
      bindings: [binding(f.targetProfileRef)],
      afterTargetCommit: crash,
    })).rejects.toThrow('fixture crash')
    expect(await readFile(f.configPath, 'utf8')).toContain('[model_providers.cordisx-work]')

    const recovered = await syncCodexProviderProfile({
      stateDir: f.stateDir,
      targetProfileRef: f.targetProfileRef,
      connections: [connection()],
      bindings: [binding(f.targetProfileRef)],
    })

    expect(crash).toHaveBeenCalledOnce()
    expect(recovered).toMatchObject({ targetChanged: false, diagnostics: [] })
    await expect(readFile(path.join(f.stateDir, 'provider-profile-transaction.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect((await new ProviderProfileSyncLedgerStore(f.stateDir).read()).bindings).toHaveLength(1)
  })

  it('projects actual target routing and never presents desired-only values as applied', async () => {
    const f = await fixture('projection')
    await syncCodexProviderProfile({
      stateDir: f.stateDir,
      targetProfileRef: f.targetProfileRef,
      connections: [connection()],
      bindings: [binding(f.targetProfileRef, { overlay: { iconRef: 'brand-work' } })],
    })
    await writeFile(
      f.configPath,
      (await readFile(f.configPath, 'utf8')).replace(
        'base_url = "https://gateway.example.test/v1"',
        'base_url = "https://actual.example.test/v1"',
      ),
    )

    const projection = await readCodexProviderProfile({
      stateDir: f.stateDir,
      targetProfileRef: f.targetProfileRef,
    })

    expect(projection.providers[0]).toMatchObject({
      endpoint: 'https://actual.example.test/v1',
      overlay: { iconRef: 'brand-work' },
      sync: { applied: false },
    })
    expect(projection.runtime.status).toBe('unverified')
    expect(JSON.stringify(projection)).not.toContain('keychain:managed-work')
  })

  it('keeps import separate from adoption and makes repeated import idempotent', async () => {
    const f = await fixture('import')
    const native = {
      sourceKind: 'native' as const,
      sourceRef: 'ignored-input-ref',
      targetProfileRef: f.targetProfileRef,
      nativeLocalId: 'native-work',
      title: 'Native Work',
      endpoint: 'https://native.example.test/v1',
      protocol: 'responses' as const,
      credential: { kind: 'environment' as const, reference: 'NATIVE_WORK_KEY' },
      activeModelId: 'model-x',
    }
    const empty = await new ProviderProfileSyncLedgerStore(f.stateDir).read()
    const first = importNativeProviderConnection({
      ledger: empty,
      native,
      credential: { secretRef: 'user-selected-secret', revision: 'credential-1' },
    })
    const second = importNativeProviderConnection({
      ledger: first.ledger,
      native,
      credential: { secretRef: 'user-selected-secret', revision: 'credential-1' },
    })
    expect(second.connection.connectionId).toBe(first.connection.connectionId)
    expect(second.ledger.imports).toHaveLength(1)
    expect(second.ledger.bindings).toEqual([])

    const adopted = adoptProviderBinding({
      ledger: second.ledger,
      connection: first.connection,
      binding: binding(f.targetProfileRef, {
        bindingId: createProviderSyncId('binding'),
        connectionId: first.connection.connectionId,
        localProviderId: 'native-work',
      }),
      targetGroups: {
        display: { name: 'Native Work' },
        routing: {
          base_url: 'https://native.example.test/v1',
          wire_api: 'responses',
          env_key: 'NATIVE_WORK_KEY',
          auth_kind: 'environment',
        },
      },
      importedFrom: native.sourceRef,
    })
    expect(adopted.bindings).toHaveLength(1)
    expect(adopted.bindings[0]).toMatchObject({ ownership: 'adopted', localProviderId: 'native-work' })
  })

  it('defines disable, detach, and tombstone behavior without deleting the target', async () => {
    const f = await fixture('lifecycle')
    const definition = connection()
    const targetBinding = binding(f.targetProfileRef)
    await syncCodexProviderProfile({
      stateDir: f.stateDir,
      targetProfileRef: f.targetProfileRef,
      connections: [definition],
      bindings: [targetBinding],
    })
    const store = new ProviderProfileSyncLedgerStore(f.stateDir)
    const ledger = await store.read()
    await store.commit(setProviderBindingState(ledger, targetBinding.bindingId, 'detached'))
    const detachedSource = await readFile(f.configPath, 'utf8')

    const detached = await syncCodexProviderProfile({
      stateDir: f.stateDir,
      targetProfileRef: f.targetProfileRef,
      connections: [connection({ endpoint: 'https://changed.example.test/v1' })],
      bindings: [targetBinding],
    })
    expect(detached.diagnostics).toContainEqual(expect.objectContaining({ code: 'binding-detached' }))
    expect(await readFile(f.configPath, 'utf8')).toBe(detachedSource)

    const disabled = await syncCodexProviderProfile({
      stateDir: path.join(f.root, 'disabled-state'),
      targetProfileRef: f.targetProfileRef,
      connections: [definition],
      bindings: [binding(f.targetProfileRef, { enabled: false, localProviderId: 'disabled-provider' })],
    })
    expect(disabled.diagnostics).toContainEqual(expect.objectContaining({ code: 'binding-disabled' }))
    expect(await readFile(f.configPath, 'utf8')).not.toContain('disabled-provider')
  })

  it('reports truthful capability support and performs no write for unsupported adapters', async () => {
    expect(providerSyncAdapterCapabilities('codex')).toMatchObject({ status: 'supported', managedSync: true })
    expect(providerSyncAdapterCapabilities('claude-code')).toMatchObject({
      status: 'unsupported',
      managedSync: false,
      resolvedRead: false,
    })
    const f = await fixture('unsupported')
    const targetProfileRef = { ...f.targetProfileRef, adapterId: 'claude-code' as const }
    const result = await syncCodexProviderProfile({
      stateDir: f.stateDir,
      targetProfileRef,
      connections: [connection()],
      bindings: [binding(targetProfileRef)],
    })
    expect(result).toMatchObject({ targetChanged: false, ledgerChanged: false })
    expect(result.diagnostics).toEqual([{ code: 'unsupported-adapter', severity: 'error' }])
    await expect(readFile(f.configPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns the existing binding identity for repeated explicit binding requests', async () => {
    const f = await fixture('binding')
    const empty = await new ProviderProfileSyncLedgerStore(f.stateDir).read()
    const first = bindProviderConnection(empty, connection(), {
      connectionId: connection().connectionId,
      targetProfileRef: f.targetProfileRef,
      localProviderId: 'cordisx-work',
      enabled: true,
      credentialDelivery: 'process-env',
    })
    const second = bindProviderConnection(first.ledger, connection({ title: 'Renamed' }), {
      connectionId: connection().connectionId,
      targetProfileRef: f.targetProfileRef,
      localProviderId: 'cordisx-work',
      enabled: true,
      credentialDelivery: 'process-env',
    })
    expect(second.binding.bindingId).toBe(first.binding.bindingId)
    expect(second.ledger.generation).toBe(first.ledger.generation)
  })
})
