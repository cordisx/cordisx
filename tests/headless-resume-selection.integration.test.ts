import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { createHeadlessNativeAuthority } from '../packages/cli/src/launcher/headless-native-authority.js'

it('reopens the real profile store and restores only its confirmed Channel selection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-resume-integration-'))
  const configPath = path.join(root, 'config.json'), profile = path.join(root, 'apps/codex/profiles/default')
  await ensureHomeConfig(configPath)
  await mkdir(profile, { recursive: true })
  const create = () =>
    createHeadlessNativeAuthority({
      homeDir: root,
      configPath,
      appId: 'codex',
      profileId: 'default',
      report: () => {},
    })
  const selection = { providerId: 'fixture-provider', model: 'fixture/model' }
  const persistChannel = () =>
    writeFile(
      path.join(profile, 'channel-conversations.json'),
      JSON.stringify({
        bindings: { group: { state: 'active', sessionId: 'thread' } },
        taskSettings: { thread: { application: 'applied', settings: selection } },
      }),
    )
  const next = vi.fn(async (params: Readonly<Record<string, unknown>>) => ({
    thread: { id: params.threadId },
    modelProvider: params.modelProvider,
    model: params.model,
  }))
  let native = await create()
  try {
    await native.authority.execution!.recordModelSelection('thread', selection)
    await persistChannel()
    await native.close()
    native = await create()
    await native.authority.nativeRequest!('thread/resume', { threadId: 'thread', excludeTurns: true }, next)
    expect(next).toHaveBeenLastCalledWith({
      threadId: 'thread',
      excludeTurns: true,
      modelProvider: selection.providerId,
      model: selection.model,
    })
    await native.authority.execution!.recordModelSelection('thread')
    await native.close()
    native = await create()
    await expect(native.authority.nativeRequest!('thread/resume', { threadId: 'thread' }, next))
      .rejects.toThrow('RESUME_SELECTION_UNCONFIRMED')
    expect(next).toHaveBeenCalledOnce()
  } finally {
    await native.close()
    await rm(root, { recursive: true, force: true })
  }
})
