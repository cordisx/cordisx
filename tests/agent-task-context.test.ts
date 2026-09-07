import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { resolveAgentTaskContext } from '../packages/cli/src/launcher/agent-task-context.js'
import {
  issueNativeSessionHostToken,
  NativeAgentSessionBridge,
} from '../packages/cli/src/launcher/native-agent-session-rpc.js'
import { OwnerDocumentStore } from '../packages/cli/src/launcher/owner-document-store.js'
import { issueOwnerDocumentPrincipalToken } from '../packages/cli/src/launcher/owner-document-rpc.js'

test('resolves only accessible absolute directories, canonicalizes links and fails closed on projects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'task-context-'))
  const inherited = async () => ({ cwd: root })
  try {
    await symlink(root, path.join(root, 'alias'))
    await writeFile(path.join(root, 'file'), 'not a directory')
    expect(await resolveAgentTaskContext({ kind: 'directory', cwd: path.join(root, 'alias') }, { inherited }))
      .toMatchObject({
        status: 'resolved',
        context: { cwd: await import('node:fs/promises').then(fs => fs.realpath(root)) },
      })
    for (const cwd of ['relative', path.join(root, 'missing'), path.join(root, 'file')]) {
      expect(await resolveAgentTaskContext({ kind: 'directory', cwd }, { inherited })).toMatchObject({
        code: 'directory-unavailable',
      })
    }
    expect(await resolveAgentTaskContext({ kind: 'project', projectId: root }, { inherited })).toMatchObject({
      code: 'project-unavailable',
    })
    expect(await resolveAgentTaskContext({ kind: 'inherit', sessionId: 'parent' }, { inherited })).toMatchObject({
      status: 'resolved',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('task intent uses Host protected owner CAS storage across generation/restart with one winner', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'task-store-'))
  const identity = { source: 'file:///task/plugin.js', pluginId: 'tasks' }
  const principal = { profileId: 'profile', generation: 'launch', moduleGeneration: 'module', identity }
  const options = {
    secret: 'secret',
    profileId: principal.profileId,
    generation: principal.generation,
    store: new OwnerDocumentStore(root),
    principalAllowed: () => true,
  }
  const token = issueOwnerDocumentPrincipalToken(options.secret, principal)
  const nativeToken = issueNativeSessionHostToken(options)
  const bridge = new NativeAgentSessionBridge(options)
  const envelope = { version: 1, requestId: '1', token, nativeToken }
  const call = (operation: string, data = {}) =>
    bridge.handle({ ...envelope, operation: `native-session-task-${operation}`, ...data })
  const record = {
    operationId: 'op',
    fingerprint: '{}',
    sessionId: 'session',
    messageId: 'message',
    context: { cwd: root },
    phase: 'intent',
  }
  try {
    const claims = await Promise.all([
      call('claim', { operationId: 'op', record }),
      call('claim', { operationId: 'op', record }),
    ])
    expect(claims).toEqual([{ claimed: true, record }, { claimed: false, record }])
    await expect(call('save', { operationId: 'op', record: { ...record, sessionId: 'other', phase: 'creating' } }))
      .rejects.toThrow('correlation')
    const restarted = new NativeAgentSessionBridge({ ...options, generation: 'next-launch' })
    expect(
      await restarted.handle({
        ...envelope,
        token: issueOwnerDocumentPrincipalToken(options.secret, {
          ...principal,
          generation: 'next-launch',
          moduleGeneration: 'next-module',
        }),
        nativeToken: issueNativeSessionHostToken({ ...options, generation: 'next-launch' }),
        operation: 'native-session-task-load',
        operationId: 'op',
      }),
    ).toEqual(record)
    expect(
      await call('load', {
        operationId: 'op',
        token: issueOwnerDocumentPrincipalToken(options.secret, {
          ...principal,
          identity: { ...identity, pluginId: 'foreign' },
        }),
      }),
    ).toBeNull()
    await expect(call('load', { operationId: 'op', nativeToken: undefined })).rejects.toThrow('Host native')
    expect(await call('context', { context: { kind: 'inherit', sessionId: 'foreign' } })).toMatchObject({
      code: 'context-unavailable',
    })
    await bridge.handle({
      ...envelope,
      operation: 'native-session-save-binding',
      sessionId: 'parent',
      threadId: 'native',
      completedTurns: 0,
      context: { cwd: root },
    })
    expect(await call('context', { context: { kind: 'inherit', sessionId: 'parent' } })).toMatchObject({
      status: 'resolved',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
