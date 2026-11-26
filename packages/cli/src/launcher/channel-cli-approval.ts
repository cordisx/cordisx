import type { ChannelNativeCliContext } from './channel-cli-context.js'

export type ChannelCliOperationKind = 'read' | 'send' | 'write' | 'checkpoint'
const READS = new Set([
  'forward-receipt',
  'thread-forward-receipt',
  'connections',
  'conversations',
  'bind-status',
  'history',
  'remote-history',
  'thread-history',
  'message-search',
  'resource-refetch',
  'resource-status',
  'resource-read',
  'message-get',
  'message-capabilities',
  'message-operation-receipt',
  'pin-list',
  'read-users',
  'reaction-list',
  'listen',
  'receipt',
  'policy',
  'group-access',
  'input-ack',
  'input-status',
  'user-access',
  'group-block',
  'execution-defaults',
  'execution-settings',
  'docs',
  'help',
  'model-list',
  'task-settings',
  'task-config',
  'task-requests',
  'continuation-checkpoint',
  'continuation-history',
])
const WRITES = new Set([
  'forward',
  'merge-forward',
  'thread-forward',
  'message-edit',
  'message-recall',
  'pin-add',
  'pin-remove',
  'card-update',
  'bind',
  'unbind',
  'reply-mode',
  'policy-set',
  'group-access-set',
  'user-access-set',
  'group-block-set',
  'execution-defaults-set',
  'execution-settings-set',
  'task-settings-set',
  'task-config-set',
  'question-cancel',
])
const MEMORY_READS = new Set(['guide', 'navigate', 'search-page', 'search', 'get', 'batch', 'grant-list'])
const MEMORY_WRITES = new Set([
  'remember',
  'update',
  'forget',
  'index',
  'grant',
  'revoke',
  'identity-unbind',
  'identity-challenge',
  'identity-confirm',
])
export function channelCliOperationKind(operation: string): ChannelCliOperationKind | undefined {
  return READS.has(operation) ? 'read' : ['send', 'send-many', 'ask', 'media-prepare'].includes(operation)
    ? 'send'
    : ['continuation-checkpoint-set', 'continuation-takeover-ready'].includes(operation)
    ? 'checkpoint'
    : WRITES.has(operation)
    ? 'write'
    : undefined
}

/** Parse literal argv only. Expansion, substitution, redirection and compound shell commands never qualify. */
function literalWords(source: string): string[] | undefined {
  const result: string[] = []
  let word = '', active = false, mode: 'single' | 'double' | undefined
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (mode === 'single') {
      if (char === "'") mode = undefined
      else word += char
    } else if (mode === 'double') {
      if (char === '"') mode = undefined
      else if (char === '$' || char === '`' || char === '\0') return undefined
      else if (char === '\\') {
        const next = source[++i]
        if (next === undefined || next === '\n' || next === '\r') return undefined
        word += ['$', '`', '"', '\\'].includes(next) ? next : `\\${next}`
      } else word += char
    } else if (char === "'" || char === '"') {
      active = true
      mode = char === "'" ? 'single' : 'double'
    } else if (char === '\\') {
      const next = source[++i]
      if (next === undefined || /[\0\r\n]/u.test(next)) return undefined
      active = true
      word += next
    } else if (/\s/u.test(char)) {
      if (/[\r\n]/u.test(char)) return undefined
      if (active) result.push(word)
      word = ''
      active = false
    } else {
      if (/[;&|<>(){}\[\]*?~$`#\0]/u.test(char)) return undefined
      active = true
      word += char
    }
  }
  if (mode !== undefined) return undefined
  if (active) result.push(word)
  return result
}

export interface ChannelCliApprovalOperation {
  readonly operation: string
  readonly kind: ChannelCliOperationKind
  readonly input: Readonly<Record<string, unknown>>
  readonly context?: string
}

/** Identity is the active Node, installed CLI, CordisX home and profile; PATH names are never trusted. */
export function configuredChannelApprovalOperation(
  command: unknown,
  context: ChannelNativeCliContext | undefined,
): ChannelCliApprovalOperation | undefined {
  if (!context) return undefined
  let words = typeof command === 'string'
    ? literalWords(command)
    : Array.isArray(command) && command.every(item => typeof item === 'string')
    ? [...command] as string[]
    : undefined
  for (let depth = 0; words && depth < 2; depth++) {
    if (!['/bin/zsh', '/bin/bash', '/bin/sh'].includes(words[0] ?? '')) break
    if (words.length !== 3 || !['-c', '-lc'].includes(words[1]!)) return undefined
    words = literalWords(words[2]!)
  }
  if (
    !words || !['env', '/usr/bin/env'].includes(words[0] ?? '')
    || words[1] !== `CORDISX_HOME=${context.home}` || words[2] !== context.node || words[3] !== context.entry
    || words[4] !== 'channel'
  ) return undefined
  const operation = words[5]
  if (!operation) return undefined
  if (operation === 'help' && words.length <= 7) return { operation, kind: 'read', input: {} }
  const helpTopic = operation === 'help' && words[6] && !words[6].startsWith('--') ? words[6] : undefined
  if (helpTopic && helpTopic !== 'memory' && !channelCliOperationKind(helpTopic)) return undefined
  const memoryAction = operation === 'memory' && words[6] && !words[6].startsWith('--') ? words[6] : undefined
  const mediaAction = operation === 'media-prepare' && words[6] && !words[6].startsWith('--') ? words[6] : undefined
  if (mediaAction && !['begin', 'chunk', 'commit'].includes(mediaAction)) return undefined
  const kind = channelCliOperationKind(operation)
  if (!kind && operation !== 'memory') return undefined
  const options = new Map<string, string>()
  for (let i = helpTopic || memoryAction || mediaAction ? 7 : 6; i < words.length; i += 2) {
    const flag = words[i], value = words[i + 1]
    if (!flag || !['--profile', '--input', '--context'].includes(flag) || value === undefined || options.has(flag)) {
      return undefined
    }
    options.set(flag, value)
  }
  if (options.get('--profile') !== context.profile || helpTopic && !options.has('--context')) return undefined
  try {
    const input: unknown = JSON.parse(options.get('--input') ?? '{}')
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
    const record = input as Record<string, unknown>
    if (operation === 'media-prepare') {
      if (!options.get('--context') || mediaAction && 'action' in record) return undefined
      const action = mediaAction ?? record.action
      if (typeof action !== 'string' || !['begin', 'chunk', 'commit'].includes(action)) return undefined
      record.action = action
    }
    let selectedKind = kind
    if (operation === 'memory') {
      if (!options.get('--context') || memoryAction && 'action' in record) return undefined
      const action = memoryAction ?? record.action
      if (typeof action !== 'string') return undefined
      selectedKind = MEMORY_READS.has(action) ? 'read' : MEMORY_WRITES.has(action) ? 'write' : undefined
      if (!selectedKind) return undefined
      record.action = action
    }
    if (!selectedKind) return undefined
    return {
      operation,
      kind: selectedKind,
      input: record,
      ...(options.has('--context') ? { context: options.get('--context')! } : {}),
    }
  } catch {
    return undefined
  }
}
