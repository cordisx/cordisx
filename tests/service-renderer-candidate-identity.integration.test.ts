import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
import { ServiceRendererIdentityProjection } from '../packages/cli/src/cli/service-renderer-identity.js'
import {
  removeStagedPluginPackage,
  stagedPluginModulePath,
  stageLocalPluginPackage,
} from '../packages/cli/src/launcher/plugin-package.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { localPackage } from './suites/plugin-lifecycle.fixtures.js'

it(
  'issues candidate aliases only for the exact owner packages and promotes them after a confirmed activation',
  async () => {
    const root = await mkdtemp('/tmp/cx-candidate-identity-')
    const homeDir = path.join(root, 'home')
    await mkdir(homeDir)
    const staged: Awaited<ReturnType<typeof stageLocalPluginPackage>>[] = []
    const firstController = new AbortController()
    const secondController = new AbortController()
    try {
      for (const [id, requiredCapability] of [['existing', false], ['new-plugin', false], ['unsafe', true]] as const) {
        const directory = await localPackage({ root, id, requiredCapability })
        const manifestFile = path.join(directory, 'cordisx.plugin.json')
        const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
        await writeFile(manifestFile, JSON.stringify({ ...manifest, canonicalSource: `https://example.test/${id}` }))
        staged.push(await stageLocalPluginPackage(homeDir, directory))
      }
      const [existing, added, unsafe] = staged
      const item = (pkg: typeof staged[number], moduleGeneration: string) => ({
        id: pkg.manifest.id,
        version: pkg.manifest.version,
        digest: pkg.digest,
        moduleGeneration,
        enabled: true,
        dependencies: pkg.manifest.dependencies,
        canonicalSource: pkg.manifest.canonicalSource,
      })
      const beforeItem = item(existing!, 'existing-1')
      const afterItem = item(added!, 'new-1')
      const before = {
        $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
        schemaVersion: 1 as const,
        recordKind: 'active' as const,
        profileId: 'default',
        revision: 1,
        lastGoodRevision: 1,
        runtimeGeneration: 'owner',
        plugins: [beforeItem],
      }
      const plugin = {
        id: beforeItem.id,
        entry: stagedPluginModulePath(homeDir, beforeItem.digest),
        source: existing!.identitySource,
        enabled: true,
        config: {},
        revision: 0,
        manifest: existing!.manifest.runtimeManifest,
        package: {
          version: beforeItem.version,
          digest: beforeItem.digest,
          moduleGeneration: beforeItem.moduleGeneration,
          dependencies: beforeItem.dependencies,
          canonicalSource: beforeItem.canonicalSource,
        },
      }
      const firstContext = {
        profileId: 'default',
        rendererId: '1'.repeat(64),
        ownerGeneration: 'owner',
        signal: firstController.signal,
      }
      const secondContext = { ...firstContext, rendererId: '2'.repeat(64), signal: secondController.signal }
      const first = new ServiceRendererIdentityProjection({ homeDir, context: firstContext, isCurrent: () => true })
      const second = new ServiceRendererIdentityProjection({ homeDir, context: secondContext, isCurrent: () => true })
      const firstOld = await first.issueInstalled(firstContext, plugin, beforeItem)
      const secondOld = await second.issueInstalled(secondContext, plugin, beforeItem)
      const candidate = {
        ...before,
        recordKind: 'candidate' as const,
        transactionId: 'install',
        revision: 2,
        plugins: [beforeItem, afterItem],
      }
      const input = {
        transactionId: 'install',
        targetId: afterItem.id,
        affectedPluginIds: [afterItem.id],
        previous: before,
        candidate,
      }
      const [firstView, secondView] = await Promise.all([
        first.prepareCandidate(firstContext, input),
        second.prepareCandidate(secondContext, input),
      ])
      const firstNew = first.candidateAlias(firstContext, 'install', afterItem.id)
      const secondNew = second.candidateAlias(secondContext, 'install', afterItem.id)
      expect(new Set([firstOld, secondOld, firstNew, secondNew]).size).toBe(4)
      expect(firstView.previous.plugins[0]!.canonicalSource).toBe(firstOld)
      expect(firstView.candidate.plugins.map(value => value.canonicalSource)).toEqual([firstOld, firstNew])
      expect(secondView.candidate.plugins.map(value => value.canonicalSource)).toEqual([secondOld, secondNew])
      expect(() => first.resolve(firstContext, firstNew, afterItem.id)).toThrow('renderer-identity-unavailable')
      expect(() => second.resolveLifecycle(secondContext, firstNew, afterItem.id)).toThrow(
        'renderer-identity-unavailable',
      )
      expect(first.resolveLifecycle(firstContext, firstNew, afterItem.id).digest).toBe(afterItem.digest)
      // A consumer cannot change the owner's reserved candidate through its copy.
      const returnedItem = firstView.candidate.plugins[1] as { version: string }
      returnedItem.version = '9.9.9'
      const { transactionId: _id, ...candidateRecord } = candidate
      void _id
      const active = { ...candidateRecord, recordKind: 'active' as const, lastGoodRevision: 2 }
      expect(() => first.commitCandidate(firstContext, 'install', { ...active, revision: 3 })).toThrow()
      first.commitCandidate(firstContext, 'install', active)
      expect(first.resolve(firstContext, firstNew, afterItem.id).source).toBe(afterItem.canonicalSource)
      expect(first.projectActivation(firstContext, active).plugins[1]!.canonicalSource).toBe(firstNew)

      const updateDirectory = await localPackage({ root, id: afterItem.id, version: '2.0.0' })
      const updateManifestFile = path.join(updateDirectory, 'cordisx.plugin.json')
      const updateManifest = JSON.parse(await readFile(updateManifestFile, 'utf8'))
      await writeFile(
        updateManifestFile,
        JSON.stringify({ ...updateManifest, canonicalSource: afterItem.canonicalSource }),
      )
      const updatedPackage = await stageLocalPluginPackage(homeDir, updateDirectory)
      staged.push(updatedPackage)
      const updatedItem = item(updatedPackage, 'new-2')
      const update = {
        ...active,
        recordKind: 'candidate' as const,
        transactionId: 'update',
        revision: 3,
        plugins: [beforeItem, updatedItem],
      }
      const updateInput = {
        transactionId: 'update',
        targetId: afterItem.id,
        affectedPluginIds: [afterItem.id],
        previous: active,
        candidate: update,
      }
      await first.prepareCandidate(firstContext, updateInput)
      const tentative = first.candidateAlias(firstContext, 'update', afterItem.id)
      expect(tentative).not.toBe(firstNew)
      first.cancelCandidate(firstContext, 'update')
      expect(first.resolve(firstContext, firstNew, afterItem.id).digest).toBe(afterItem.digest)
      expect(() => first.resolveLifecycle(firstContext, tentative, afterItem.id)).toThrow()
      await first.prepareCandidate(firstContext, updateInput)
      const finalAlias = first.candidateAlias(firstContext, 'update', afterItem.id)
      const { transactionId: _updateId, ...updateRecord } = update
      void _updateId
      const updatedActive = { ...updateRecord, recordKind: 'active' as const, lastGoodRevision: 3 }
      first.commitCandidate(firstContext, 'update', updatedActive)
      expect(() => first.resolve(firstContext, firstNew, afterItem.id)).toThrow()
      expect(first.resolve(firstContext, finalAlias, afterItem.id).digest).toBe(updatedItem.digest)

      second.cancelCandidate(secondContext, 'other-transaction')
      expect(second.resolveLifecycle(secondContext, secondNew, afterItem.id).digest).toBe(afterItem.digest)
      second.cancelCandidate(secondContext, 'install')
      expect(() => second.resolveLifecycle(secondContext, secondNew, afterItem.id)).toThrow()
      expect(second.projectActivation(secondContext, before).plugins[0]!.canonicalSource).toBe(secondOld)

      const blocked = {
        ...candidate,
        transactionId: 'unsafe-install',
        plugins: [beforeItem, item(unsafe!, 'unsafe-1')],
      }
      await expect(second.prepareCandidate(secondContext, {
        transactionId: 'unsafe-install',
        targetId: 'unsafe',
        affectedPluginIds: ['unsafe'],
        previous: before,
        candidate: blocked,
      })).rejects.toThrow('renderer-projection-plugin-unsupported')
      const tampered = {
        ...before,
        recordKind: 'candidate' as const,
        transactionId: 'tampered',
        revision: 2,
        plugins: [{ ...beforeItem, version: '9.9.9' }],
      }
      await expect(second.prepareCandidate(secondContext, {
        transactionId: 'tampered',
        targetId: beforeItem.id,
        affectedPluginIds: [beforeItem.id],
        previous: before,
        candidate: tampered,
      })).rejects.toThrow()
      await expect(second.prepareCandidate(secondContext, input)).resolves.toMatchObject({
        previous: { revision: 1 },
        candidate: { revision: 2 },
      })
      const dependentDirectory = await localPackage({
        root,
        id: 'dependent',
        dependencies: [{ id: beforeItem.id, version: beforeItem.version }],
      })
      const dependentManifestFile = path.join(dependentDirectory, 'cordisx.plugin.json')
      const dependentManifest = JSON.parse(await readFile(dependentManifestFile, 'utf8'))
      await writeFile(
        dependentManifestFile,
        JSON.stringify({
          ...dependentManifest,
          canonicalSource: 'https://example.test/dependent',
        }),
      )
      const dependentPackage = await stageLocalPluginPackage(homeDir, dependentDirectory)
      staged.push(dependentPackage)
      const disabledBase = { ...beforeItem, enabled: false }
      const disabledDependent = { ...item(dependentPackage, 'dependent-1'), enabled: false }
      const disabled = { ...before, revision: 5, lastGoodRevision: 5, plugins: [disabledBase, disabledDependent] }
      const thirdContext = { ...firstContext, rendererId: '3'.repeat(64) }
      const third = new ServiceRendererIdentityProjection({ homeDir, context: thirdContext, isCurrent: () => true })
      for (const [activation, pkg] of [[disabledBase, existing!], [disabledDependent, dependentPackage]] as const) {
        await third.issueInstalled(thirdContext, {
          id: activation.id,
          entry: stagedPluginModulePath(homeDir, activation.digest),
          source: pkg.identitySource,
          enabled: activation.enabled,
          config: {},
          revision: 0,
          manifest: pkg.manifest.runtimeManifest,
          package: {
            version: activation.version,
            digest: activation.digest,
            moduleGeneration: activation.moduleGeneration,
            dependencies: activation.dependencies,
            canonicalSource: activation.canonicalSource,
          },
        }, activation)
      }
      const enabled = {
        ...disabled,
        recordKind: 'candidate' as const,
        transactionId: 'enable-with-dependent',
        revision: 6,
        plugins: [{ ...disabledBase, enabled: true, moduleGeneration: 'existing-2' }, disabledDependent],
      }
      const enable = {
        transactionId: 'enable-with-dependent',
        targetId: disabledBase.id,
        previous: disabled,
        candidate: enabled,
      }
      await expect(third.prepareCandidate(thirdContext, { ...enable, affectedPluginIds: [disabledBase.id] }))
        .rejects.toThrow('renderer-identity-unavailable')
      await expect(third.prepareCandidate(thirdContext, {
        ...enable,
        affectedPluginIds: [disabledDependent.id, disabledBase.id],
      })).resolves.toMatchObject({ candidate: { revision: 6 } })
      third.close()
      firstController.abort()
      expect(() => first.resolve(firstContext, finalAlias, afterItem.id)).toThrow()
      second.close()
    } finally {
      firstController.abort()
      secondController.abort()
      await Promise.allSettled(staged.map(async pkg => await removeStagedPluginPackage(homeDir, pkg.digest)))
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  60_000,
)
