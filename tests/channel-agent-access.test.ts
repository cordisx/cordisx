import { describe, expect, it } from 'vitest'
import { ChannelAgentAccess } from '../packages/cli/src/launcher/channel-agent-access.js'
import { configuredChannelApprovalOperation } from '../packages/cli/src/launcher/channel-cli-approval.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'

const context = { node: '/fixed/node', entry: '/fixed/cli.js', home: "/tmp/user's home", profile: 'preview' }
const source = {
  adapterId: 'feishu',
  accountId: 'account',
  tenantId: 'tenant',
  conversationId: 'oc_group',
  kind: 'group' as const,
  threadId: 'oc_group',
  semantics: 'conversation' as const,
  eventId: 'om_event',
  actor: { adapterId: 'feishu', accountId: 'account', tenantId: 'tenant', userId: 'ou_alice' },
}
const argv = (op: string, input: unknown = {}, token?: string) => [
  'env',
  `CORDISX_HOME=${context.home}`,
  context.node,
  context.entry,
  'channel',
  op,
  '--profile',
  context.profile,
  '--input',
  JSON.stringify(input),
  ...(token ? ['--context', token] : []),
]
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

describe('configured Channel CLI routine approval', () => {
  it('recognizes exact literal argv and nested shell quoting, but never expansions or a different runtime', () => {
    const command = argv('connections')
    expect(configuredChannelApprovalOperation(command, context)?.kind).toBe('read')
    expect(configuredChannelApprovalOperation(['/bin/zsh', '-lc', command.map(quote).join(' ')], context)?.kind).toBe(
      'read',
    )
    for (
      const text of [
        command.map(quote).join(' ') + '; echo injected',
        '$(echo injected)',
        command.map(quote).join(' ') + ' > /tmp/file',
        'env CORDISX_HOME="$HOME" node cli channel connections',
      ]
    ) {
      expect(configuredChannelApprovalOperation(['/bin/zsh', '-lc', text], context)).toBeUndefined()
    }
    expect(configuredChannelApprovalOperation(command.map(value => value === context.node ? 'node' : value), context))
      .toBeUndefined()
    expect(
      configuredChannelApprovalOperation(command.map(value => value === context.profile ? 'default' : value), context),
    ).toBeUndefined()
    expect(configuredChannelApprovalOperation(argv('task-settings-set'), context)?.kind).toBe('write')
    for (const operation of ['user-access', 'group-block']) {
      expect(configuredChannelApprovalOperation(argv(operation), context)?.kind).toBe('read')
    }
    for (const operation of ['user-access-set', 'group-block-set']) {
      expect(configuredChannelApprovalOperation(argv(operation), context)?.kind).toBe('write')
    }
    expect(configuredChannelApprovalOperation(argv('task-approve'), context)).toBeUndefined()
  })

  it('allows reads and policy-approved source replies, preserves explicit send denials and fences old context', () => {
    let policy = parseChannelConversationPolicy({ enabled: true })
    const native = {
      hasPreparation: () => false,
      isPreparing: () => false,
      sourceFor: (thread: string, turn?: string) =>
        thread === 'chat' && (!turn || turn === 'turn') ? source : undefined,
      contextFor: (token: string) =>
        token === 'current'
          ? { source, threadId: 'chat', turnId: 'turn' }
          : token === 'old'
          ? { source, threadId: 'chat', turnId: 'older' }
          : undefined,
      cliApprovalOperation: (command: unknown) => configuredChannelApprovalOperation(command, context),
    }
    const access = new ChannelAgentAccess(
      () => ({ policy, bindings: {}, jobs: {}, inputs: {} }) as never,
      () => native as never,
    )
    const help = (topic: string, token: string) => [
      'env',
      `CORDISX_HOME=${context.home}`,
      context.node,
      context.entry,
      'channel',
      'help',
      topic,
      '--profile',
      context.profile,
      '--context',
      token,
    ]
    expect(access.routine(help('send', 'current'), 'chat', 'turn')).toBe(true)
    expect(access.routine(help('receipt', 'current'), 'chat', 'turn')).toBe(true)
    expect(access.routine(help('receipt', 'old'), 'chat', 'turn')).toBe(false)
    expect(access.routine(help('unknown', 'current'), 'chat', 'turn')).toBe(false)
    expect(
      access.routine(
        help('send', 'current').map(value => value === context.node ? '/other/node' : value),
        'chat',
        'turn',
      ),
    ).toBe(false)
    expect(access.routine(argv('history', { sessionId: 'chat' }), 'chat', 'turn')).toBe(true)
    expect(access.routine(argv('user-access', { user: 'ou_member' }, 'current'), 'chat', 'turn')).toBe(true)
    expect(access.routine(argv('user-access', { user: 'ou_member' }, 'old'), 'chat', 'turn')).toBe(false)
    expect(access.routine(argv('user-access-set', {}, 'current'), 'chat', 'turn')).toBe(false)
    expect(access.routine(argv('group-block-set', {}, 'current'), 'chat', 'turn')).toBe(false)
    expect(access.routine(argv('history', { sessionId: 'other' }), 'chat', 'turn')).toBe(false)
    const memory = (action: string, token?: string) => {
      const command = argv('memory', {}, token)
      command.splice(6, 0, action)
      return command
    }
    for (const action of ['guide', 'navigate', 'search-page', 'search', 'get', 'batch', 'grant-list']) {
      expect(access.routine(memory(action, 'current'), 'chat', 'turn')).toBe(true)
      expect(access.routine(memory(action, 'old'), 'chat', 'turn')).toBe(false)
      expect(access.routine(memory(action), 'chat', 'turn')).toBe(false)
      expect(access.routine(argv('memory', { action }, 'current'), 'chat', 'turn')).toBe(true)
    }
    for (const action of ['remember', 'update', 'forget', 'index', 'grant', 'revoke', 'identity-confirm']) {
      expect(access.routine(memory(action, 'current'), 'chat', 'turn')).toBe(false)
    }
    expect(access.routine(memory('unknown', 'current'), 'chat', 'turn')).toBe(false)
    expect(access.routine(help('memory', 'current'), 'chat', 'turn')).toBe(true)
    const conflicting = memory('search', 'current')
    conflicting[conflicting.indexOf('--input') + 1] = JSON.stringify({ action: 'remember' })
    expect(access.routine(conflicting, 'chat', 'turn')).toBe(false)
    const send = {
      account: { adapterId: 'feishu', accountId: 'account', tenantId: 'tenant' },
      target: { id: 'oc_group', kind: 'group' },
      text: 'hello',
      operationId: 'one',
    }
    expect(access.routine(argv('send', send, 'current'), 'chat', 'turn')).toBe(true)
    expect(access.routine(argv('ask', send, 'current'), 'chat', 'turn')).toBe(true)
    expect(
      access.routine(argv('ask', { ...send, target: { id: 'oc_other', kind: 'group' } }, 'current'), 'chat', 'turn'),
    ).toBe(false)
    expect(
      access.routine(argv('question-cancel', { account: send.account, operationId: 'one' }, 'current'), 'chat', 'turn'),
    ).toBe(false)
    expect(access.routine(argv('send', send, 'old'), 'chat', 'turn')).toBe(false)
    expect(access.routine(argv('send', { ...send, target: { id: 'oc_other', kind: 'group' } }), 'chat', 'turn')).toBe(
      false,
    )
    expect(access.routine(argv('task-settings-set', {}), 'chat', 'turn')).toBe(false)
    const checkpoint = {
      goal: 'task',
      constraints: 'keep history',
      completed: 'one',
      remaining: 'two',
      history: 'source',
      continueAtIdle: true,
    }
    const save = { expectedRevision: 0, checkpoint }
    expect(access.routine(argv('continuation-checkpoint', {}, 'current'), 'chat', 'turn')).toBe(true)
    expect(access.routine(argv('continuation-history', { limit: 2 }, 'current'), 'chat', 'turn')).toBe(true)
    expect(access.routine(argv('continuation-checkpoint-set', save, 'current'), 'chat', 'turn')).toBe(true)
    expect(access.routine(argv('continuation-checkpoint', {}), 'chat', 'turn')).toBe(false)
    expect(access.routine(argv('continuation-history', { sourceId: 'other' }, 'current'), 'chat', 'turn')).toBe(false)
    expect(access.routine(argv('continuation-checkpoint-set', save, 'old'), 'chat', 'turn')).toBe(false)
    expect(
      access.routine(argv('continuation-checkpoint-set', { ...save, sessionId: 'other' }, 'current'), 'chat', 'turn'),
    ).toBe(false)
    expect(
      access.routine(
        argv(
          'continuation-checkpoint-set',
          { ...save, checkpoint: { ...checkpoint, continueAtIdle: 'yes' } },
          'current',
        ),
        'chat',
        'turn',
      ),
    ).toBe(false)
    expect(access.routine(argv('continuation-policy-set', {}, 'current'), 'chat', 'turn')).toBe(false)
    expect(access.routine(argv('continuation-start', {}, 'current'), 'chat', 'turn')).toBe(false)
    expect(
      access.caller({
        'cordisx/channelContext': 'current',
        'x-codex-turn-metadata': { thread_id: 'other', turn_id: 'turn' },
      }),
    ).toBeUndefined()
    policy = parseChannelConversationPolicy({
      enabled: true,
      rules: [{ id: 'deny', action: 'send', effect: 'deny', userIds: ['ou_alice'] }],
    })
    expect(access.routine(argv('send', send), 'chat', 'turn')).toBe(false)
  })
})
