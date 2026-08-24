import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CommandRegistry } from '../packages/cli/src/renderer/commands.js'
import { GenerationVisibilityCoordinator } from '../packages/cli/src/renderer/generation-visibility.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID } from '../packages/cli/src/renderer/ownership.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1, type CordisXPluginActivationRecordV1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import {
  CORDISX_SURFACE_INVOCATION_CONTEXT_SCHEMA_V1,
  type CordisXCommandContext,
} from '../packages/cli/src/contracts.js'
import {
  CORDISX_BUILTIN_EXTENSION_POINT_CATALOG,
  CORDISX_EXTENSION_POINT_LOCALE_CATALOGS,
  ExtensionPointDescriptorRegistry,
  ExtensionPointPolicyBroker,
  MemoryExtensionPointPolicyStore,
} from '../packages/cli/src/renderer/extension-points.js'

describe('CommandRegistry', () => {
  it('keeps same-id generations isolated and fences the retiring handler at publish', async () => {
    const record = (revision: number, moduleGeneration: string): CordisXPluginActivationRecordV1 => ({
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: revision === 1 ? 'active' : 'candidate',
      ...(revision === 1 ? {} : { transactionId: 'update-demo' }),
      profileId: 'default',
      revision,
      lastGoodRevision: 1,
      runtimeGeneration: 'runtime-1',
      plugins: [{
        id: 'demo', version: '1.0.0', digest: `sha256:${(revision === 1 ? 'a' : 'b').repeat(64)}`,
        moduleGeneration, enabled: true, dependencies: [],
      }],
    })
    const previous = record(1, 'demo-1')
    const candidate = record(2, 'demo-2')
    const visibility = new GenerationVisibilityCoordinator(previous)
    const registry = new CommandRegistry(undefined, visibility)
    const oldContext = new Context().extend({ [CORDISX_PLUGIN_ID]: 'demo', [CORDISX_PLUGIN_GENERATION]: 'demo-1' })
    let oldAborted = false
    const removeOld = registry.register(oldContext, { id: 'run', title: { key: 'run' } }, ({ signal }) => {
      signal.addEventListener('abort', () => { oldAborted = true })
      return new Promise(() => {})
    })
    void registry.execute('demo', { id: 'run' })

    const handle = visibility.begin('update-demo', previous, candidate)
    const candidateContext = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'demo',
      [CORDISX_PLUGIN_GENERATION]: 'demo-2',
      ...visibility.context(handle, 'demo'),
    })
    let candidateCalls = 0
    registry.register(candidateContext, { id: 'run', title: { key: 'run' } }, () => { candidateCalls += 1 })
    expect(registry.snapshot()).toHaveLength(1)
    await registry.execute(candidateContext, { id: 'run' })
    expect(candidateCalls).toBe(1)

    const receipt = visibility.confirmReadiness(handle)
    visibility.publish(visibility.preparePublish(handle, receipt))
    expect(oldAborted).toBe(true)
    await registry.execute('demo', { id: 'run' })
    expect(candidateCalls).toBe(2)
    removeOld()
    expect(registry.snapshot()).toHaveLength(1)
    registry.dispose()
  })

  it('qualifies ownership, enforces public references, tracks loading, and freezes arguments', async () => {
    const registry = new CommandRegistry()
    let release: (() => void) | undefined
    let received: unknown
    registry.register('alpha', { id: 'run', title: { key: 'run' }, public: true }, async (context) => {
      received = context.arguments
      await new Promise<void>(resolve => { release = resolve })
      return 'done'
    })

    const execution = registry.execute('beta', { id: 'alpha:run', arguments: { value: 1 } }, 'button')
    expect(registry.snapshot()[0]?.running).toBe(1)
    await expect(registry.execute('beta', { id: 'alpha:run' }, 'button')).rejects.toThrow(/already running/)
    expect(Object.isFrozen(received)).toBe(true)
    release?.()
    await expect(execution).resolves.toBe('done')
    expect(registry.snapshot()[0]?.running).toBe(0)

    registry.register('alpha', { id: 'private', title: { key: 'private' } }, () => undefined)
    expect(registry.has('beta', { id: 'alpha:private' })).toBe(false)
    await expect(registry.execute('beta', { id: 'alpha:private' })).rejects.toThrow(/private/)
    registry.dispose()
  })

  it('aborts in-flight handlers on owner disposal and records non-abort failures', async () => {
    const registry = new CommandRegistry()
    let aborted = false
    const remove = registry.register('demo', { id: 'slow', title: { key: 'slow' } }, ({ signal }) => {
      signal.addEventListener('abort', () => { aborted = true })
      return new Promise(() => {})
    })
    void registry.execute('demo', { id: 'slow' })
    remove()
    expect(aborted).toBe(true)

    registry.register('demo', { id: 'fail', title: { key: 'fail' } }, () => { throw new Error('boom') })
    await expect(registry.execute('demo', { id: 'fail' })).rejects.toThrow('boom')
    expect(registry.snapshot()[0]?.lastError).toBe('boom')
    registry.dispose()
  })

  it('rechecks host-generated surface origin without disabling the command elsewhere', async () => {
    const descriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
    descriptors.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
    const broker = new ExtensionPointPolicyBroker(descriptors, new MemoryExtensionPointPolicyStore())
    const identity = { source: 'https://plugins.example/demo', id: 'demo' }
    broker.register(identity)
    const registry = new CommandRegistry(broker)
    let executions = 0
    registry.register('demo', { id: 'open', title: { key: 'open' } }, () => { executions += 1 })
    broker.setPolicy(identity, 'sidebar.navigation.items', 'deny')

    await expect(registry.execute('demo', { id: 'open' }, 'stale', {
      pointId: 'sidebar.navigation.items', contributionId: 'demo:navigation',
    })).rejects.toThrow(/denied/)
    expect(executions).toBe(0)
    await expect(registry.execute('demo', { id: 'open' }, 'direct')).resolves.toBeUndefined()
    await expect(registry.execute('demo', { id: 'open' }, 'allowed', {
      pointId: 'sidebar.footer.before-control', contributionId: 'demo:footer',
    })).resolves.toBeUndefined()
    expect(executions).toBe(2)
    registry.dispose()
    broker.dispose()
    descriptors.dispose()
  })

  it('injects only matching immutable host context and never promotes plugin arguments', async () => {
    const descriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
    descriptors.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
    const broker = new ExtensionPointPolicyBroker(descriptors, new MemoryExtensionPointPolicyStore())
    broker.register({ source: 'https://plugins.example/demo', id: 'demo' })
    const registry = new CommandRegistry(broker)
    let received: CordisXCommandContext | undefined
    registry.register('demo', { id: 'trace', title: { key: 'trace' } }, context => { received = context })
    const hostContext = {
      $schema: CORDISX_SURFACE_INVOCATION_CONTEXT_SCHEMA_V1,
      schemaVersion: 1 as const,
      generation: 'generation-test',
      contextRef: 'context-1',
      pointId: 'session.header.actions',
      contributionId: 'demo:trace',
      commandId: 'demo:trace',
      provenance: 'observed' as const,
      source: { kind: 'adapter' as const, adapterId: 'codex', adapterVersion: 'fixture', hostId: 'com.openai.codex' },
      identity: { agent: { sessionKey: 'session-opaque' } },
    }

    await registry.execute('demo', { id: 'trace', arguments: { sessionId: 'spoofed' } }, 'surface', {
      pointId: 'session.header.actions', contributionId: 'demo:trace', context: hostContext,
    })
    expect(received?.hostContext).toEqual(hostContext)
    expect(Object.isFrozen(received?.hostContext)).toBe(true)
    expect(Object.isFrozen(received?.hostContext?.identity.agent)).toBe(true)
    expect(received?.arguments).toEqual({ sessionId: 'spoofed' })
    await registry.execute('demo', { id: 'trace', arguments: { hostContext } as never }, 'direct')
    expect(received?.hostContext).toBeUndefined()
    await expect(registry.execute('demo', { id: 'trace' }, 'mismatch', {
      pointId: 'composer.toolbar.items', contributionId: 'demo:trace', context: hostContext,
    })).rejects.toThrow(/does not match/)
    registry.dispose()
    broker.dispose()
    descriptors.dispose()
  })
})
