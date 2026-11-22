import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import {
  managementMailboxPath,
  requestManagementMailbox,
  startManagementMailbox,
} from '../packages/cli/src/launcher/management-mailbox.js'
import {
  managementMailboxRoot,
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  startPluginManagementRpcServer,
} from '../packages/cli/src/launcher/management-rpc.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'

describe('sandboxed management mailbox', () => {
  it('routes Channel and Codex requests through the existing Host handlers with source context', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-mailbox-'))
    const channel = vi.fn(async (operation, input, metadata) => ({ status: 'ok', operation, input, metadata }))
    const codex = vi.fn(async (operation, input, metadata) => ({ status: 'ok', operation, input, metadata }))
    const server = await startPluginManagementRpcServer({
      homeDir,
      appId: 'codex',
      profileId: 'default',
      configPath: path.join(homeDir, 'config.json'),
      sandboxMailbox: true,
      generation: 'fixture',
      processStartedAt: (await processStartIdentity(process.pid))!,
      service: {} as PluginManagementService,
      channel,
      codex,
    })
    try {
      const paths = pluginManagementRpcPaths(homeDir, 'codex', 'default')
      const endpoint = (await readPluginManagementRpcEndpoint(paths))!
      const directory = managementMailboxPath(managementMailboxRoot(paths), endpoint.mailboxId!)
      const context = 'a'.repeat(48)
      const call = (operation: unknown) =>
        requestManagementMailbox({
          directory,
          token: endpoint.token,
          value: {
            version: 1,
            requestId: 'management-fixture',
            token: endpoint.token,
            profileId: 'default',
            operation,
          },
          timeoutMs: 2000,
        })
      await expect(call({ kind: 'channel', operation: 'docs', context, callerThreadId: 'thread', input: {} }))
        .resolves.toMatchObject({ status: 'ok', operation: 'docs' })
      expect(channel).toHaveBeenCalledWith('docs', {}, {
        'cordisx/channelContext': context,
        'openai/threadId': 'thread',
      })
      await expect(call({
        kind: 'codex',
        operation: 'execution:execution-settings',
        context,
        callerThreadId: 'thread',
        input: {},
      })).resolves.toMatchObject({ status: 'ok' })
      expect(codex).toHaveBeenCalledWith(
        'execution:execution-settings',
        {},
        expect.objectContaining({
          'cordisx/channelContext': context,
          'openai/threadId': 'thread',
        }),
      )
      await expect(call({ kind: 'channel', operation: 'task-config-set', input: {} })).rejects.toThrow(
        'MAILBOX_REQUEST_REJECTED',
      )
      await expect(call({ kind: 'query' })).rejects.toThrow('MAILBOX_REQUEST_REJECTED')
      await expect(requestManagementMailbox({
        directory,
        token: 'b'.repeat(64),
        timeoutMs: 350,
        value: {
          version: 1,
          requestId: 'management-forged',
          token: endpoint.token,
          profileId: 'default',
          operation: { kind: 'channel', operation: 'docs', context, input: {} },
        },
      })).rejects.toThrow('MAILBOX_RESULT_UNKNOWN')
      await expect(call({ kind: 'codex', operation: 'model-services:save', context, input: {} })).rejects.toThrow(
        'MAILBOX_REQUEST_REJECTED',
      )
      await expect(call({
        kind: 'codex',
        operation: 'configuration:reviewer-set',
        context,
        callerThreadId: 'thread',
        input: { sessionId: 'thread', reviewer: 'auto_review', expectedRevision: 0 },
      })).rejects.toThrow('MAILBOX_REQUEST_REJECTED')
      expect(channel).toHaveBeenCalledOnce()
      expect(codex).toHaveBeenCalledOnce()
    } finally {
      await server.close()
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'linux')(
    'keeps host file access pinned when the mailbox path is replaced',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cx-mailbox-replacement-'))
      const directory = path.join(root, 'mailbox'), moved = path.join(root, 'moved'), decoy = path.join(root, 'decoy')
      await mkdir(decoy)
      const server = await startManagementMailbox({ directory, token: 'a'.repeat(64), dispatch: async () => ({}) })
      try {
        await rename(directory, moved)
        await symlink(decoy, directory)
        const sentinel = path.join(decoy, `${'f'.repeat(32)}.req`)
        await writeFile(sentinel, 'untrusted')
        await new Promise(resolve => setTimeout(resolve, 350))
        await expect(access(sentinel)).resolves.toBeUndefined()
      } finally {
        await server.close()
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('does not dispatch unauthenticated messages or store request data as plaintext', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-mailbox-encrypted-'))
    try {
      const pending = requestManagementMailbox({
        directory,
        token: 'a'.repeat(64),
        value: { message: 'private request content' },
        timeoutMs: 400,
      })
      const rejected = expect(pending).rejects.toThrow('MAILBOX_RESULT_UNKNOWN')
      await new Promise(resolve => setTimeout(resolve, 30))
      const files = await readdir(directory)
      expect(files).toHaveLength(1)
      const raw = await readFile(path.join(directory, files[0]!), 'utf8')
      expect(raw).not.toContain('private request content')
      expect(raw).not.toContain('a'.repeat(64))
      await rejected
      expect(await readdir(directory)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
