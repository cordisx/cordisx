import { isDeepStrictEqual } from 'node:util'
import { parse, stringify, type TomlTable } from 'smol-toml'
import type { HomeConfigModelServiceProvider } from '../config/home-config.js'
import { CODEX_RUNTIME_OPTION_KEYS, modelServiceCodexProvider } from './model-service-runtime.js'

const SOURCE_MARKER = '# cordisx-model-service-runtime-options'
const CLEARED_MARKER = '# cordisx-cleared-model-service-options'
type Ownership = 'source' | 'cleared'
const HEADER = /^\s*(\[[^\n]+?\])\s*(?:#.*)?$/u
const table = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

function providerSections(raw: string) {
  const sections: Array<{ id: string | undefined; start: number; end: number; ownership: Ownership | undefined }> = []
  let offset = 0
  for (const line of raw.split(/(?<=\n)/u)) {
    const header = HEADER.exec(line.trimEnd())?.[1]
    if (header) {
      // A line inside a multiline value may resemble a header. The semantic
      // round-trip check below prevents treating it as an actual table edit.
      let id: string | undefined
      try {
        const parsed = table(parse(`${header}\n`).model_providers)
        id = parsed ? Object.keys(parsed)[0] : undefined
      } catch {}
      const prior = sections.at(-1)
      if (prior) prior.end = offset
      sections.push({
        id,
        start: offset,
        end: raw.length,
        ownership: line.trimEnd().endsWith(` ${SOURCE_MARKER}`)
          ? 'source'
          : line.trimEnd().endsWith(` ${CLEARED_MARKER}`)
          ? 'cleared'
          : undefined,
      })
    }
    offset += line.length
  }
  return sections
}

/** The cleared marker records ownership history only, across fresh launcher processes. */
export function modelServiceRuntimeOwnership(raw: string): ReadonlyMap<string, Ownership> {
  return new Map(
    providerSections(raw).flatMap(section =>
      section.id !== undefined && section.ownership !== undefined ? [[section.id, section.ownership] as const] : []
    ),
  )
}

/** Rewrite each owned provider once, including child tables separated by other providers. */
export function projectModelServiceCodexOptions(
  raw: string,
  providers: readonly HomeConfigModelServiceProvider[],
): string {
  const sections = providerSections(raw)
  const marked = new Set(
    sections.flatMap(section => section.ownership === 'source' && section.id !== undefined ? [section.id] : []),
  )
  const applicable = new Map(providers.map(provider => [provider.id, provider]))
  const owned = new Set([
    ...marked,
    ...providers.filter(provider => provider.runtimeOptions !== undefined).map(provider => provider.id),
  ])
  if (owned.size === 0) return raw

  const expected = parse(raw)
  const definitions = table(expected.model_providers) ?? {}
  const replacements = new Map<number, string>()
  for (const id of owned) {
    const spans = sections.filter(section => section.id === id)
    const definition = table(definitions[id])
    if (spans.length === 0 || definition === undefined) throw new Error('Model service provider table is not writable')
    for (const key of CODEX_RUNTIME_OPTION_KEYS) delete definition[key]
    const provider = applicable.get(id)
    const hasOptions = provider?.runtimeOptions != null
    if (hasOptions) {
      const mapped = modelServiceCodexProvider(provider)
      for (const key of CODEX_RUNTIME_OPTION_KEYS) {
        if (Object.hasOwn(mapped, key)) definition[key] = mapped[key as keyof typeof mapped]
      }
    }
    const replacement = stringify({ model_providers: { [id]: definition } } as TomlTable)
    const first = spans[0]!
    const marker = hasOptions ? SOURCE_MARKER : CLEARED_MARKER
    replacements.set(first.start, replacement.replace(/^(\[model_providers[^\n]+\])/mu, `$1 ${marker}`) + '\n')
    for (const span of spans.slice(1)) replacements.set(span.start, '')
  }
  let updated = raw
  for (const section of [...sections].reverse()) {
    const replacement = replacements.get(section.start)
    if (replacement !== undefined) updated = updated.slice(0, section.start) + replacement + updated.slice(section.end)
  }
  if (!isDeepStrictEqual(parse(updated), expected)) {
    throw new Error('Model service options would change unrelated Codex config')
  }
  return updated
}
