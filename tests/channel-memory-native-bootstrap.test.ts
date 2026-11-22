import { mkdtemp, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { expect, it } from 'vitest'
import { ChannelMemoryPersonas } from '../packages/cli/src/launcher/channel-memory-personas.js'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'

it('real native start injects bound persona, pins session and suppresses repeated capsules', async () => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'native-persona-'))
  try {
    const personas = new ChannelMemoryPersonas(root)
    const account = { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant' }
    await personas.profile('atlas', 'Atlas', 'Careful assistant', 0)
    await personas.bind(account, 'atlas', 0)
    const prompts: string[] = []
    const native = new ChannelNativeSessions({
      cwd: root,
      cli: { node: process.execPath, entry: path.join(root, 'cli.js'), home: root, profile: 'test' },
      nativeRequest: async () => ({ thread: { id: 'session', status: { type: 'idle' } } }),
      bridge: () =>
        ({
          call: async (_provider: string, operation: string, args: any) => {
            if (operation === 'start_session' || operation === 'send_message') {
              prompts.push(args.prompt)
              return { status: 'started', sessionId: 'session', turnId: `turn-${prompts.length}` }
            }
            return {}
          },
        }) as never,
    })
    native.setPersonaRegistry(personas)
    const message = {
      source: {
        event: { ...account, conversationId: 'A', actor: { userId: 'alice' }, kind: 'direct', messageId: 'one' },
      },
      receivedAt: new Date().toISOString(),
      content: [{ type: 'text', text: 'Recall Cedar' }],
    } as never
    expect((await native.start('job-one', message)).state).toBe('running')
    expect(prompts[0]).toContain('Atlas')
    expect((await native.start('job-two', message, 'session')).state).toBe('running')
    expect(prompts[1]).not.toContain('"personaId"')
    for (const prompt of prompts) {
      expect(prompt).toContain('channel memory')
      expect(prompt).toContain('proactively retain useful concise task knowledge')
      expect(prompt).toContain('first retrieve authorized memory')
      expect(prompt).toContain("--profile 'test' --context")
    }
    native.resetPersonaContext('session')
    await native.start('reset-job', message, 'session')
    expect(prompts.pop()).toContain('Atlas')
    await personas.profile('atlas', 'Atlas updated', 'Careful assistant', 1)
    await native.start('job-three', message, 'session')
    expect(prompts[2]).toContain('Atlas updated')
    await personas.profile('nova', 'Nova', 'Other assistant', 0)
    await personas.bind(account, 'nova', 1)
    await native.start('job-four', message, 'session')
    expect(prompts[3]).not.toContain('Nova')
    const currentRevision = (await personas.bootstrap('session', account)).contextRevision
    await personas.contextSettings('atlas', 'A', { language: 'Chinese', tone: 'normal' }, currentRevision)
    await native.start('job-style', message, 'session')
    expect(prompts[4]).toContain('Chinese')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('unbound accounts receive memory guidance without creating a persona or task binding', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-memory-unbound-'))
  try {
    const registry = new ChannelMemoryPersonas(root),
      account = { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant' }
    let prompt = ''
    const native = new ChannelNativeSessions({
      cwd: root,
      cli: { node: process.execPath, entry: path.join(root, 'cli.js'), home: root, profile: 'test' },
      bridge: () =>
        ({
          call: async (_provider: string, _operation: string, args: { prompt: string }) => {
            prompt = args.prompt
            return { status: 'started', sessionId: 'session', turnId: 'turn' }
          },
        }) as never,
    })
    native.setPersonaRegistry(registry)
    const result = await native.start('job', {
      source: {
        event: { ...account, conversationId: 'A', actor: { userId: 'alice' }, kind: 'direct', messageId: 'one' },
      },
      receivedAt: new Date().toISOString(),
      content: [{ type: 'text', text: 'Recall Cedar progress' }],
    } as never)
    expect(result.state).toBe('running')
    expect(prompt).toContain('channel memory')
    expect(prompt).toContain('first retrieve authorized memory')
    expect(prompt).not.toContain('"personaId"')
    expect(await registry.taskConfigured('session', account)).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
