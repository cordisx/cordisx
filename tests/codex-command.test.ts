import { expect, test } from 'vitest'
import { codexCommandError, codexRpcError } from '../packages/cli/src/cli/codex-command.js'
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

test('model defaults, Fast and project settings retain explicit scope and false values', async () => {
  expect(
    await parseCodexCommand([
      'chats',
      'reviewer',
      'set',
      '--session',
      'chat',
      '--revision',
      '3',
      '--reviewer',
      'auto_review',
    ]),
  ).toMatchObject({
    operation: 'configuration:reviewer-set',
    input: { sessionId: 'chat', expectedRevision: 3, reviewer: 'auto_review' },
  })
  await expect(parseCodexCommand([
    'chats',
    'reviewer',
    'set',
    '--session',
    'chat',
    '--revision',
    '3',
    '--reviewer',
    'never',
  ])).rejects.toThrow()
  expect(
    await parseCodexCommand([
      'defaults',
      'model',
      'set',
      '--revision',
      '0',
      '--provider',
      'p',
      '--model',
      'm',
      '--fast',
      'false',
    ]),
  ).toMatchObject({
    operation: 'configuration:model-defaults-set',
    input: { settings: { providerId: 'p', model: 'm', fast: false }, expectedRevision: 0 },
  })
  expect(await parseCodexCommand(['chats', 'fast', 'set', '--revision', '1', '--fast', 'true'])).toMatchObject({
    operation: 'configuration:fast-set',
    input: { fast: true, expectedRevision: 1 },
  })
  expect(
    await parseCodexCommand([
      'chats',
      'project',
      'set',
      '--session',
      'chat',
      '--revision',
      '0',
      '--project',
      'p',
      '--cwd',
      '/repo',
    ]),
  ).toMatchObject({
    operation: 'configuration:project-set',
    input: { sessionId: 'chat', projectId: 'p', cwd: '/repo' },
  })
  expect(await parseCodexCommand(['chats', 'create', '--message', 'work', '--operation', 'op'])).toMatchObject({
    operation: 'create',
    input: { operationId: 'op' },
  })
  for (
    const args of [['defaults', 'model', 'get', '--session', 'chat'], [
      'chats',
      'fast',
      'set',
      '--revision',
      '0',
      '--fast',
      'yes',
    ], ['chats', 'project', 'set', '--revision', '0']]
  ) await expect(parseCodexCommand(args)).rejects.toThrow()
})

test('distinguishes an unsupported old Host for the read-only capability query', () => {
  const rejection = new Error('plugin management operation is unsupported')
  expect(codexRpcError('capabilities', rejection).message).toBe('CODEX_RUNTIME_INCOMPATIBLE')
  expect(codexCommandError(codexRpcError('capabilities', rejection))).toMatchObject({
    code: 'CODEX_RUNTIME_INCOMPATIBLE',
    automaticRetry: false,
  })
  expect(codexRpcError('create', rejection).message).toBe('CODEX_RPC_RESULT_UNKNOWN')
  expect(codexRpcError('capabilities', new Error('timeout')).message).toBe('CODEX_RPC_RESULT_UNKNOWN')
})
