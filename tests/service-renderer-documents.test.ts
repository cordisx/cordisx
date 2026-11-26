import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ServiceRendererDocuments } from '../packages/cli/src/cli/service-renderer-documents.js'
import type {
  ServiceRendererBootstrapEntry,
  ServiceRendererSnapshot,
} from '../packages/cli/src/cli/service-renderer-bootstrap-state.js'
import type { ManagerRendererChannelContext } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import type { PluginRuntimeMutation } from '../packages/cli/src/launcher/plugin-lifecycle-model.js'
import { OwnerDocumentStore } from '../packages/cli/src/launcher/owner-document-store.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-renderer-documents-'))
  roots.push(homeDir)
  const source = 'https://example.test/plugin'
  const alias = `https://renderer.cordisx.invalid/plugin/${'a'.repeat(64)}`
  const nextAlias = `https://renderer.cordisx.invalid/plugin/${'b'.repeat(64)}`
  const abort = new AbortController()
  const context: ManagerRendererChannelContext = {
    profileId: 'default',
    rendererId: 'renderer',
    ownerGeneration: 'generation',
    signal: abort.signal,
    admitted: true,
  }
  const plugin = { id: 'example', enabled: true, moduleGeneration: 'module-1' }
  let snapshot = { active: { plugins: [plugin] }, registryEpoch: 1 } as ServiceRendererSnapshot
  let currentAlias = alias
  const identity = {
    currentAlias: () => currentAlias,
    candidateAlias: () => nextAlias,
    resolveLifecycle: (_context: unknown, value: string, id: string) => {
      if (![alias, nextAlias].includes(value) || id !== plugin.id) throw new Error('unknown identity')
      return { source, pluginId: id, digest: 'digest' }
    },
  }
  const entry = {
    snapshot,
    bootstrapConfirmed: true,
    identity,
    identityContext: context,
    identityAliases: new Map([[plugin.id, alias]]),
  } as unknown as ServiceRendererBootstrapEntry
  const entries = new Map([[context.rendererId, entry]])
  const documents = new ServiceRendererDocuments({
    homeDir,
    profileId: context.profileId,
    generation: context.ownerGeneration,
    entries,
    current: (id, value) => entries.get(id) === value,
    snapshot: () => snapshot,
  })
  const channel = documents.channel()
  const call = async (token: string, operation: 'load' | 'replace', caller = context) => {
    const payload = JSON.stringify({
      version: 1,
      requestId: 'request-1',
      token,
      operation,
      documentId: 'settings',
      ...(operation === 'replace' ? { expectedRevision: 0, schemaVersion: 1, value: { visible: true } } : {}),
    })
    const prepared = channel.prepare(payload, caller)
    return { mode: prepared.mode, result: await prepared.dispatch() as { value: { status: string } } }
  }
  return {
    homeDir,
    source,
    alias,
    nextAlias,
    context,
    abort,
    entry,
    documents,
    call,
    promote(next: ServiceRendererSnapshot) {
      snapshot = next
      entry.snapshot = next
      currentAlias = nextAlias
    },
  }
}

it('keeps document grants scoped to the admitted renderer and the owner identity', async () => {
  const test = await fixture()
  const [binding] = test.documents.initial(test.context, test.entry)
  expect(binding!.source).toBe(test.alias)
  expect(JSON.stringify(binding)).not.toContain(test.source)
  const starting = { ...test.context, admitted: false }
  expect((await test.call(binding!.token, 'load', starting)).result.value.status).toBe('missing')
  expect((await test.call(binding!.token, 'replace', starting)).result.value.status).toBe('unavailable')
  expect((await test.call(binding!.token, 'load')).result.value.status).toBe('missing')
  const write = await test.call(binding!.token, 'replace')
  expect(write.mode).toBe('write')
  expect(write.result.value.status).toBe('accepted')
  const stored = await new OwnerDocumentStore(test.homeDir).load(
    { profileId: 'default', identity: { pluginId: 'example', source: test.source } },
    'settings',
  )
  expect(stored.status).toBe('loaded')
  const other = { ...test.context, signal: new AbortController().signal }
  expect((await test.call(binding!.token, 'load', other)).result.value.status).toBe('unavailable')
  test.abort.abort()
  expect((await test.call(binding!.token, 'replace')).result.value.status).toBe('unavailable')
})

it('does not dispatch candidate document writes until the new generation is committed', async () => {
  const test = await fixture()
  const [old] = test.documents.initial(test.context, test.entry)
  const next = { id: 'example', enabled: true, moduleGeneration: 'module-2' }
  const candidate = { ...test.entry.snapshot!.active, recordKind: 'candidate', plugins: [next] }
  const mutation = {
    transactionId: 'change',
    affectedPluginIds: ['example'],
    candidate,
  } as unknown as PluginRuntimeMutation
  test.entry.pendingIdentity = {
    transactionId: 'change',
    candidate,
  } as ServiceRendererBootstrapEntry['pendingIdentity']
  test.entry.lifecycleTransition = { isCurrent: () => true }
  const [binding] = test.documents.candidate(test.context, test.entry, mutation)
  const staged = await test.call(binding!.token, 'replace')
  expect(staged.mode).toBe('read')
  expect(staged.result.value.status).toBe('unavailable')
  const active = { active: { ...candidate, recordKind: 'active' }, registryEpoch: 2 } as ServiceRendererSnapshot
  test.promote(active)
  delete test.entry.lifecycleTransition
  expect((await test.call(old!.token, 'replace')).result.value.status).toBe('unavailable')
  expect((await test.call(binding!.token, 'replace')).result.value.status).toBe('accepted')
})
