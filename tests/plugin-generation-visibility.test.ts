import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  GenerationVisibilityCoordinator,
  type PluginGenerationEffectIdentity,
  type PluginGenerationTransitionHandle,
  type PluginGenerationView,
} from '../packages/cli/src/renderer/generation-visibility.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID } from '../packages/cli/src/renderer/ownership.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationItemV1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`

function plugin(
  id: string,
  moduleGeneration: string,
  dependencies: readonly { id: string; version: string }[] = [],
): CordisXPluginActivationItemV1 {
  return {
    id,
    version: '1.0.0',
    digest: digest(id === 'base' ? 'a' : 'b'),
    moduleGeneration,
    enabled: true,
    dependencies,
  }
}

function activation(
  revision: number,
  plugins: readonly CordisXPluginActivationItemV1[],
): CordisXPluginActivationRecordV1 {
  return {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: revision === 1 ? 'active' : 'candidate',
    ...(revision === 1 ? {} : { transactionId: 'update-base' }),
    profileId: 'default',
    revision,
    lastGoodRevision: 1,
    runtimeGeneration: 'runtime-1',
    plugins,
  }
}

class ExistingRegistry {
  private readonly records: { identity: PluginGenerationEffectIdentity; value: string }[] = []
  notifications = 0
  readonly notifiedVersions: number[] = []

  constructor(private readonly visibility: GenerationVisibilityCoordinator) {
    visibility.connect({
      notify: version => {
        this.notifications += 1
        this.notifiedVersions.push(version)
      },
    })
  }

  register(ctx: Context, value: string): () => void {
    const identity = this.visibility.effect(ctx)
    this.records.push({ identity, value })
    return () => {
      const index = this.records.findIndex(record => record.identity === identity && record.value === value)
      if (index >= 0) this.records.splice(index, 1)
    }
  }

  snapshot(view?: PluginGenerationView): readonly string[] {
    return this.records.filter(record => this.visibility.visible(record.identity, view)).map(record => record.value)
  }
}

function context(
  pluginId: string,
  moduleGeneration: string,
  visibility: GenerationVisibilityCoordinator,
  handle?: PluginGenerationTransitionHandle,
): Context {
  const root = new Context()
  return root.extend({
    [CORDISX_PLUGIN_ID]: pluginId,
    [CORDISX_PLUGIN_GENERATION]: moduleGeneration,
    ...(handle === undefined ? {} : visibility.context(handle, pluginId)),
  })
}

describe('generation visibility coordinator', () => {
  it('keeps staged effects in the candidate view and flips every registry before bounded notification', () => {
    const previous = activation(1, [
      plugin('base', 'base-1'),
      plugin('consumer', 'consumer-1', [{ id: 'base', version: '1.0.0' }]),
    ])
    const candidate = activation(2, [
      { ...plugin('base', 'base-2'), digest: digest('c') },
      plugin('consumer', 'consumer-2', [{ id: 'base', version: '1.0.0' }]),
    ])
    const visibility = new GenerationVisibilityCoordinator(previous)
    const commands = new ExistingRegistry(visibility)
    const pages = new ExistingRegistry(visibility)
    commands.register(context('base', 'base-1', visibility), 'old-command')
    pages.register(context('consumer', 'consumer-1', visibility), 'old-page')

    const handle = visibility.begin('update-base', previous, candidate)
    const baseCandidate = context('base', 'base-2', visibility, handle)
    const consumerCandidate = context('consumer', 'consumer-2', visibility, handle)
    commands.register(baseCandidate, 'new-command')
    pages.register(consumerCandidate, 'new-page')
    expect(commands.snapshot()).toEqual(['old-command'])
    expect(pages.snapshot()).toEqual(['old-page'])
    expect(commands.snapshot(visibility.view(baseCandidate))).toEqual(['new-command'])
    expect(pages.snapshot(visibility.view(consumerCandidate))).toEqual(['new-page'])
    expect([commands.notifications, pages.notifications]).toEqual([0, 0])

    visibility.connect({
      notify: () => {
        expect(commands.snapshot()).toEqual(['new-command'])
        expect(pages.snapshot()).toEqual(['new-page'])
      },
    })
    const receipt = visibility.confirmReadiness(handle)
    const barrier = visibility.preparePublish(handle, receipt)
    const publication = visibility.publish(barrier)

    expect(receipt).toMatchObject({ expectedRegistryEpoch: 0, afterRegistryEpoch: 1 })
    expect(publication.registryEpoch).toBe(1)
    expect([commands.notifications, pages.notifications]).toEqual([1, 1])
    expect(commands.notifiedVersions).toEqual([1])
    expect(pages.notifiedVersions).toEqual([1])
    visibility.completeLastGood(publication)
    const committed = { ...candidate, recordKind: 'active' as const, lastGoodRevision: 2 }
    delete (committed as { transactionId?: string }).transactionId
    const next = {
      ...committed,
      recordKind: 'candidate' as const,
      transactionId: 'update-base-again',
      revision: 3,
      plugins: committed.plugins.map(item =>
        item.id === 'base'
          ? { ...item, digest: digest('d'), moduleGeneration: 'base-3' }
          : item
      ),
    }
    expect(visibility.begin('update-base-again', committed, next).affectedPluginIds).toEqual(['base', 'consumer'])
  })

  it('recomputes closure, rejects stale seats, and contains prepare/listener failures', () => {
    const previous = activation(1, [
      plugin('base', 'base-1'),
      plugin('consumer', 'consumer-1', [{ id: 'base', version: '1.0.0' }]),
    ])
    const candidate = activation(2, [
      { ...plugin('base', 'base-2'), digest: digest('c') },
      plugin('consumer', 'consumer-2', [{ id: 'base', version: '1.0.0' }]),
    ])
    const visibility = new GenerationVisibilityCoordinator(previous)
    const handle = visibility.begin('update-base', previous, candidate)
    expect(handle.affectedPluginIds).toEqual(['base', 'consumer'])
    expect(() => visibility.view(context('base', 'wrong-generation', visibility, handle))).toThrow('stale or forged')

    let notifications = 0
    const disconnect = visibility.connect({
      prepare: () => {
        throw new Error('fixture prepare failure')
      },
      notify: () => {
        notifications += 1
      },
    })
    const receipt = visibility.confirmReadiness(handle)
    expect(() => visibility.preparePublish(handle, receipt)).toThrow('fixture prepare failure')
    expect(visibility.snapshot()).toBe(previous)
    expect(notifications).toBe(0)
    disconnect()

    const notifiedVersions: number[] = []
    visibility.connect({
      notify: version => {
        notifiedVersions.push(version)
      },
    })
    visibility.connect({
      notify: () => {
        throw new Error('fixture listener failure')
      },
    })
    const publication = visibility.publish(visibility.preparePublish(handle, receipt))
    expect(publication.active).toBe(candidate)
    expect(publication.notificationErrors).toHaveLength(1)
    expect(visibility.rollback(publication)).toBe(previous)
    expect(visibility.rollback(publication)).toBe(previous)
    expect(notifiedVersions).toEqual([1, 2])
    visibility.completeRollback(publication)
    expect(() => visibility.publish(visibility.preparePublish(handle, receipt))).toThrow('stale or forged')
  })
})
