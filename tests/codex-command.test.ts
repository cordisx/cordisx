import { expect, test } from 'vitest'
import { parseCodexCommand } from '../packages/cli/src/cli/codex-command-parse.js'

test('CLI distinguishes chat/current targets from explicit defaults and rejects unsupported scopes', async () => {
  expect(
    await parseCodexCommand([
      'chats',
      'settings',
      'set',
      '--session',
      'chat',
      '--revision',
      '1',
      '--network',
      'false',
      '--effort',
      'high',
    ]),
  )
    .toMatchObject({
      operation: 'execution:execution-settings-set',
      input: { sessionId: 'chat', expectedRevision: 1, settings: { effort: 'high', networkAccess: false } },
    })
  expect(await parseCodexCommand(['chats', 'settings', 'get'])).toMatchObject({ input: {} })
  expect(await parseCodexCommand(['defaults', 'set', '--revision', '0', '--approval', 'never']))
    .toMatchObject({
      operation: 'execution:execution-defaults-set',
      input: { expectedRevision: 0, settings: { approval: 'never' } },
    })
  expect(await parseCodexCommand(['chats', 'provider', 'set', '--provider', 'p', '--model', 'm']))
    .toMatchObject({ operation: 'select', input: { providerId: 'p', model: 'm' } })
  for (
    const args of [
      ['defaults', 'set', '--session', 'chat', '--revision', '0'],
      ['chats', 'settings', 'set', '--revision', '1', '--network', 'no'],
      ['chats', 'settings', 'set', '--revision', '9007199254740992'],
      ['providers', 'list', '--host', 'remote'],
      ['chats', 'settings', 'get', '--session', 'a', '--session', 'b'],
      ['chats', 'settings', 'set', '--revision', '0', '--fast', 'true'],
    ]
  ) await expect(parseCodexCommand(args)).rejects.toThrow()
})
test('provider-aware CLI creation preserves a stable operation and native project target', async () => {
  expect(
    await parseCodexCommand([
      'chats',
      'create',
      '--provider',
      'p',
      '--model',
      'm',
      '--message',
      'work',
      '--operation',
      'op',
      '--project',
      'project',
    ]),
  )
    .toMatchObject({
      operation: 'create',
      input: { operationId: 'op', target: { type: 'project', projectId: 'project', environment: { type: 'local' } } },
    })
})
