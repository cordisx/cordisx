import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { parse, type TomlTable, type TomlValue } from 'smol-toml'
import type { ProviderSyncTargetProfileRef } from './provider-profile-sync-contracts.js'
import type { ProviderSyncFieldGroups } from './provider-profile-sync-ledger.js'
import { providerSyncRevision } from './provider-profile-sync-ledger.js'
import type { CodexProviderTargetSnapshot } from './provider-profile-sync-projection.js'

const MAX_CONFIG_BYTES = 4 * 1024 * 1024
const TABLE_HEADER =
  /^\s*\[\s*model_providers\.((?:[A-Za-z0-9_-]+)|(?:"(?:[^"\\]|\\.)*")|(?:'(?:[^']*)'))\s*\]\s*(?:#.*)?$/u
const ANY_TABLE_HEADER = /^\s*\[[^\]]+\]\s*(?:#.*)?$/u
const ROOT_INLINE_PROVIDERS = /^\s*model_providers\s*=\s*\{/mu
const DISPLAY_KEYS = new Set(['name'])
const ROUTING_KEYS = new Set([
  'base_url',
  'wire_api',
  'env_key',
  'requires_openai_auth',
  'experimental_bearer_token',
])

interface ProviderTableSpan {
  readonly providerId: string
  readonly start: number
  readonly end: number
}

export interface CodexProviderWritableTargetSnapshot extends CodexProviderTargetSnapshot {
  readonly tables: ReadonlyMap<string, ProviderTableSpan>
}

function table(value: TomlValue | undefined): TomlTable | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
    ? value as TomlTable
    : undefined
}

function parseHeaderId(value: string): string | undefined {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string
    } catch {
      return undefined
    }
  }
  if (value.startsWith("'")) return value.slice(1, -1)
  return value
}

function providerTableSpans(raw: string): ReadonlyMap<string, ProviderTableSpan> {
  const lines = raw.split(/(?<=\n)/u)
  const starts: Array<{ providerId: string; start: number }> = []
  let offset = 0
  for (const line of lines) {
    const match = TABLE_HEADER.exec(line.trimEnd())
    const providerId = match?.[1] === undefined ? undefined : parseHeaderId(match[1])
    if (providerId !== undefined) starts.push({ providerId, start: offset })
    offset += line.length
  }
  const result = new Map<string, ProviderTableSpan>()
  for (const item of starts) {
    let end = raw.length
    const suffixLines = raw.slice(item.start).split(/(?<=\n)/u)
    let cursor = item.start
    for (const [lineIndex, line] of suffixLines.entries()) {
      if (lineIndex > 0 && ANY_TABLE_HEADER.test(line.trimEnd())) {
        end = cursor
        break
      }
      cursor += line.length
    }
    if (result.has(item.providerId)) throw new Error('Codex provider configuration has duplicate tables')
    result.set(item.providerId, { ...item, end })
  }
  return result
}

export async function readCodexProviderTarget(
  target: ProviderSyncTargetProfileRef,
): Promise<CodexProviderWritableTargetSnapshot | undefined> {
  const file = path.join(target.configRoot, 'config.toml')
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) throw new Error('Codex config is invalid')
      const raw = await handle.readFile('utf8')
      if (Buffer.byteLength(raw) > MAX_CONFIG_BYTES) throw new Error('Codex config is invalid')
      return Object.freeze({
        raw,
        revision: providerSyncRevision(raw),
        config: parse(raw),
        tables: providerTableSpans(raw),
      })
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function codexProviderTargetGroups(config: TomlTable, providerId: string): ProviderSyncFieldGroups {
  const provider = table(table(config.model_providers)?.[providerId])
  if (provider === undefined) return Object.freeze({})
  const display: Record<string, string | boolean> = Object.create(null)
  const routing: Record<string, string | boolean> = Object.create(null)
  if (typeof provider.name === 'string' || typeof provider.name === 'boolean') display.name = provider.name
  for (const key of ROUTING_KEYS) {
    if (key === 'experimental_bearer_token') continue
    const value = provider[key]
    if (typeof value === 'string' || typeof value === 'boolean') routing[key] = value
  }
  if (typeof provider.experimental_bearer_token === 'string') routing.auth_kind = 'inline-private'
  else if (typeof provider.env_key === 'string') routing.auth_kind = 'environment'
  else if (provider.requires_openai_auth === false) routing.auth_kind = 'none'
  else routing.auth_kind = 'native'
  return Object.freeze({
    ...(Object.keys(display).length === 0 ? {} : { display: Object.freeze(display) }),
    routing: Object.freeze(routing),
  })
}

export function codexTargetHasUnsupportedInlineProviders(raw: string): boolean {
  return ROOT_INLINE_PROVIDERS.test(raw)
}

function tomlValue(value: string | boolean): string {
  return typeof value === 'boolean' ? String(value) : JSON.stringify(value)
}

function tomlTableKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(value) ? value : JSON.stringify(value)
}

function splitInlineComment(line: string): { readonly body: string; readonly comment: string } {
  let quote: '"' | "'" | undefined
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quote === '"' && escaped) {
      escaped = false
      continue
    }
    if (quote === '"' && character === '\\') {
      escaped = true
      continue
    }
    if (character === '"' || character === "'") {
      quote = quote === character ? undefined : quote === undefined ? character : quote
      continue
    }
    if (character === '#' && quote === undefined) return { body: line.slice(0, index), comment: line.slice(index) }
  }
  return { body: line, comment: '' }
}

function editProviderTable(
  raw: string,
  span: ProviderTableSpan,
  desired: ProviderSyncFieldGroups,
  apply: readonly ('display' | 'routing')[],
): string {
  const lines = raw.slice(span.start, span.end).split(/(?<=\n)/u)
  const groups = new Set(apply)
  const desiredValues: Record<string, string | boolean> = Object.create(null)
  if (groups.has('display')) Object.assign(desiredValues, desired.display)
  if (groups.has('routing')) {
    for (const [key, value] of Object.entries(desired.routing ?? {})) {
      if (key !== 'auth_kind') desiredValues[key] = value
    }
  }
  const touchedKeys = new Set<string>()
  const output = lines.map((line, index) => {
    if (index === 0) return line
    const newline = line.endsWith('\n') ? '\n' : ''
    const content = newline === '' ? line : line.slice(0, -1)
    const { body, comment } = splitInlineComment(content)
    const match = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*/u.exec(body)
    if (match === null) return line
    const key = match[2]
    if (key === undefined) return line
    const owned = groups.has('display') && DISPLAY_KEYS.has(key) || groups.has('routing') && ROUTING_KEYS.has(key)
    if (!owned) return line
    touchedKeys.add(key)
    const value = desiredValues[key]
    if (value === undefined) return comment === '' ? '' : `${match[1]}${comment}${newline}`
    return `${match[1]}${key} = ${tomlValue(value)}${comment === '' ? '' : ` ${comment}`}${newline}`
  })
  const additions = Object.entries(desiredValues)
    .filter(([key]) => !touchedKeys.has(key))
    .map(([key, value]) => `${key} = ${tomlValue(value)}\n`)
  const insertion = output.length > 1 && output.at(-1)?.trim() === '' ? output.length - 1 : output.length
  output.splice(insertion, 0, ...additions)
  return `${raw.slice(0, span.start)}${output.join('')}${raw.slice(span.end)}`
}

function appendProviderTable(raw: string, providerId: string, desired: ProviderSyncFieldGroups): string {
  const fields = { ...desired.display, ...desired.routing }
  delete fields.auth_kind
  const body = Object.entries(fields).map(([key, value]) => `${key} = ${tomlValue(value)}`).join('\n')
  return `${raw}${raw.length === 0 || raw.endsWith('\n') ? '' : '\n'}${
    raw.trim().length === 0 ? '' : '\n'
  }[model_providers.${tomlTableKey(providerId)}]\n${body}\n`
}

export function applyCodexProviderTargetPlans(
  snapshot: CodexProviderWritableTargetSnapshot,
  plans: readonly {
    readonly localProviderId: string
    readonly desired: ProviderSyncFieldGroups
    readonly apply: readonly ('display' | 'routing')[]
  }[],
): string {
  let raw = snapshot.raw
  for (const plan of plans) {
    if (plan.apply.length === 0) continue
    const current = { ...snapshot, raw, config: parse(raw), tables: providerTableSpans(raw) }
    const span = current.tables.get(plan.localProviderId)
    raw = span === undefined
      ? appendProviderTable(raw, plan.localProviderId, plan.desired)
      : editProviderTable(raw, span, plan.desired, plan.apply)
    parse(raw)
  }
  return raw
}
