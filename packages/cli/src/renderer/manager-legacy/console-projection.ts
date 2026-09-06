import {
  type CordisXPluginConsoleEntryV1,
  type CordisXPluginConsolePageV1,
  type CordisXPluginConsoleValueSummaryV1,
} from '../../contracts.js'

export interface PluginConsoleLunaEntryProjection {
  readonly entry: CordisXPluginConsoleEntryV1
  readonly type: CordisXPluginConsoleEntryV1['method']
  readonly args: readonly unknown[]
  readonly header: {
    readonly time: string
    readonly from: string
  }
}

/** Rehydrate only the immutable Host snapshot, never the original plugin value or getter. */
export function projectPluginConsoleValueForLuna(snapshot: CordisXPluginConsoleValueSummaryV1): unknown {
  if (snapshot.type === 'undefined') return undefined
  if (snapshot.type === 'null') return null
  if (snapshot.type === 'boolean' || snapshot.type === 'number' || snapshot.type === 'string') return snapshot.value
  if (snapshot.type === 'bigint') {
    try {
      return BigInt(String(snapshot.value ?? snapshot.preview).replace(/n$/u, ''))
    } catch {
      return snapshot.preview
    }
  }
  if (snapshot.type === 'error') {
    const name = snapshot.name ?? 'Error'
    const prefix = `${name}: `
    const message = snapshot.preview.startsWith(prefix) ? snapshot.preview.slice(prefix.length) : snapshot.preview
    const error = new Error(message)
    error.name = name
    if (snapshot.stack !== undefined) {
      Object.defineProperty(error, 'stack', { configurable: true, value: snapshot.stack })
    }
    return error
  }
  if (snapshot.type === 'array') {
    const value = (snapshot.items ?? []).map(projectPluginConsoleValueForLuna)
    if (snapshot.truncated === true) Object.defineProperty(value, '[[Truncated]]', { enumerable: true, value: true })
    return value
  }
  if (snapshot.type === 'object') {
    const value: Record<string, unknown> = {}
    for (const item of snapshot.entries ?? []) {
      Object.defineProperty(value, item.key, {
        configurable: true,
        enumerable: true,
        writable: false,
        value: projectPluginConsoleValueForLuna(item.value),
      })
    }
    if (snapshot.truncated === true) Object.defineProperty(value, '[[Truncated]]', { enumerable: true, value: true })
    return value
  }
  return snapshot.preview
}

export function lunaConsoleTime(timestamp: number, includeMilliseconds = false): string {
  const date = new Date(timestamp)
  const parts = [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, '0'))
  return `${parts.join(':')}${includeMilliseconds ? `.${String(date.getMilliseconds()).padStart(3, '0')}` : ''}`
}

/** Keep each Host entry independent and preserve native Console argument-array semantics. */
export function projectPluginConsoleEntryForLuna(entry: CordisXPluginConsoleEntryV1): PluginConsoleLunaEntryProjection {
  const values = entry.args.map(projectPluginConsoleValueForLuna)
  return {
    entry,
    type: entry.method,
    args: entry.kind === 'console' ? (values.length === 0 ? [entry.message] : values) : [entry.message, ...values],
    header: { time: lunaConsoleTime(entry.time), from: entry.source },
  }
}

export function pluginConsoleEntryCopyText(entry: CordisXPluginConsoleEntryV1): string {
  const args = entry.args.map(argument => argument.preview).join(' ')
  return `${lunaConsoleTime(entry.time, true)} ${entry.method} ${entry.source} ${
    entry.kind === 'console' ? args || entry.message : `${entry.message}${args === '' ? '' : ` ${args}`}`
  }`
}

/**
 * Export only Host-issued entries for the page identity. Keep each immutable
 * `args` array intact: collapsing it into message text would change native
 * console.* semantics and lose the ownership fence carried by every entry.
 */
export function serializePluginConsoleExport(
  page: CordisXPluginConsolePageV1,
  exportedAt = new Date().toISOString(),
): string {
  const entries = page.entries.filter(entry => (
    entry.plugin.source === page.plugin.source && entry.plugin.pluginId === page.plugin.pluginId
  ))
  return JSON.stringify({ exportedAt, plugin: page.plugin, generation: page.generation, entries }, undefined, 2)
}

export interface PluginConsoleRuntimeSummary {
  readonly requests: number
  readonly successes: number
  readonly failures: number
  readonly denials: number
  readonly averageDurationMs: number | undefined
  readonly consumption: readonly string[]
}

/** Host-owned aggregate telemetry belongs to runtime state, not the log viewer. */
export function summarizePluginConsole(page: CordisXPluginConsolePageV1): PluginConsoleRuntimeSummary {
  const requests = page.entries.filter(entry => entry.kind === 'invocation' && entry.phase === 'requested').length
  const successes = page.entries.filter(entry => entry.kind === 'invocation' && entry.phase === 'success').length
  const failures = page.entries.filter(entry => entry.kind === 'invocation' && entry.phase === 'failure').length
  const denials = page.entries.filter(entry => entry.kind === 'permission' && entry.phase === 'deny').length
  const durations = page.entries.filter(entry => entry.kind === 'invocation' && entry.durationMs !== undefined).map(
    entry => entry.durationMs!,
  )
  const sources = new Map<string, { calls: number; items: number; bytes: number }>()
  for (const entry of page.entries) {
    if (entry.kind === 'invocation' && entry.phase === 'requested') {
      const current = sources.get(entry.source) ?? { calls: 0, items: 0, bytes: 0 }
      current.calls += 1
      sources.set(entry.source, current)
    }
    if (entry.kind === 'invocation' && ['success', 'failure', 'cancel'].includes(entry.phase ?? '')) {
      const current = sources.get(entry.source) ?? { calls: 0, items: 0, bytes: 0 }
      current.items += entry.result?.itemCount ?? 0
      current.bytes += entry.result?.byteCount ?? 0
      sources.set(entry.source, current)
    }
  }
  return {
    requests,
    successes,
    failures,
    denials,
    averageDurationMs: durations.length === 0
      ? undefined
      : durations.reduce((sum, value) => sum + value, 0) / durations.length,
    consumption: [...sources].map(([source, value]) =>
      `${source}: ${value.calls} calls${value.items === 0 ? '' : ` · ${value.items} items`}${
        value.bytes === 0 ? '' : ` · ${value.bytes} B`
      }`
    ),
  }
}
