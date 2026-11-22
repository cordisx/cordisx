import type { ContinuationHistoryCategoryV1 } from '@cordisx/protocol/conversation-continuation/v1'
import { pageTranscript } from './agent-bridge-transcript.js'

export type LogicalHistoryCategory = ContinuationHistoryCategoryV1
export type LogicalHistoryOmission =
  | 'attachment'
  | 'raw-reasoning'
  | 'encrypted-reasoning'
  | 'unsupported'
  | 'not-authorized'
export interface LogicalHistoryEntry {
  readonly category: LogicalHistoryCategory
  readonly text: string
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const CATEGORIES: readonly LogicalHistoryCategory[] = ['user-text', 'assistant-text', 'plan', 'command', 'tool']
const OMITTED: readonly LogicalHistoryOmission[] = [
  'attachment',
  'raw-reasoning',
  'encrypted-reasoning',
  'unsupported',
  'not-authorized',
]

/** Project only explicitly consented fields. Original native items are never changed. */
export function projectLogicalHistory(
  items: readonly unknown[],
  categories: readonly LogicalHistoryCategory[],
  options: { readonly limit?: number; readonly cursor?: unknown; readonly budget?: number } = {},
) {
  if (
    items.length > 32 || !categories.length || categories.some(category => !CATEGORIES.includes(category))
    || new Set(categories).size !== categories.length
    || options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 32)
    || options.budget !== undefined
      && (!Number.isInteger(options.budget) || options.budget < 1 || options.budget > 60_000)
  ) throw new Error('INVALID_HISTORY_REQUEST')
  const allowed = new Set(categories),
    entries: { role: string; text: string }[] = [],
    omissions = new Set<LogicalHistoryOmission>()
  const emit = (category: LogicalHistoryCategory, text: string) => {
    if (!allowed.has(category)) omissions.add('not-authorized')
    else entries.push({ role: category, text })
  }
  for (const value of items) {
    const item = record(value)
    if (!item || typeof item.type !== 'string') throw new Error('INVALID_NATIVE_HISTORY')
    if (item.type === 'userMessage') {
      if (!Array.isArray(item.content)) throw new Error('INVALID_NATIVE_HISTORY')
      const text: string[] = []
      for (const value of item.content) {
        const content = record(value)
        if (!content || typeof content.type !== 'string') throw new Error('INVALID_NATIVE_HISTORY')
        if (content.type === 'text' && typeof content.text === 'string') text.push(content.text)
        else if (['image', 'localImage', 'audio', 'localAudio'].includes(content.type)) omissions.add('attachment')
        else omissions.add('unsupported')
      }
      if (text.length) emit('user-text', text.join('\n'))
    } else if (item.type === 'agentMessage' && typeof item.text === 'string') emit('assistant-text', item.text)
    else if (item.type === 'plan' && typeof item.text === 'string') emit('plan', item.text)
    else if (item.type === 'reasoning') {
      // Native projections need not expose encrypted bytes; neither form is shared by this capability.
      omissions.add('raw-reasoning')
      omissions.add('encrypted-reasoning')
    } else if (item.type === 'commandExecution' && typeof item.command === 'string') {
      const selected = {
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        command: item.command,
        ...(typeof item.aggregatedOutput === 'string' ? { output: item.aggregatedOutput } : {}),
        ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
      }
      emit('command', JSON.stringify(selected))
    } else if (['mcpToolCall', 'dynamicToolCall', 'fileChange'].includes(item.type)) {
      const selected = Object.fromEntries(
        ['type', 'id', 'callId', 'server', 'tool', 'arguments', 'result', 'error', 'changes']
          .flatMap(key => Object.hasOwn(item, key) ? [[key, item[key]]] : []),
      )
      emit('tool', JSON.stringify(selected))
    } else omissions.add('unsupported')
  }
  const page = pageTranscript(entries, {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
  })
  return {
    entries: page.entries.map(entry => ({ category: entry.role as LogicalHistoryCategory, text: entry.text })),
    omitted: OMITTED.filter(omission => omissions.has(omission)),
    truncated: page.truncated,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    clippedCharacters: page.clippedCharacters,
  }
}
