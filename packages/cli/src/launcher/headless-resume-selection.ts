import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ChatExecutionRecord } from './chat-execution-preferences.js'

type Selection = { providerId: string; model: string }
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const selection = (value: unknown): Selection | undefined => {
  const row = object(value)
  return typeof row.providerId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(row.providerId)
      && typeof row.model === 'string' && row.model.trim().length > 0 && row.model.length <= 512
      && !/[\u0000-\u001f\u007f]/u.test(row.model)
    ? { providerId: row.providerId, model: row.model }
    : undefined
}
async function document(file: string): Promise<Record<string, unknown>> {
  try {
    return object(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('RESUME_SELECTION_STORE_UNAVAILABLE')
  }
}

/** Restore only an independently confirmed selection for this exact profile and thread. */
export async function headlessResumeSelection(input: {
  profileDirectory: string
  threadId: string
  execution?: ChatExecutionRecord | undefined
}): Promise<Selection | undefined> {
  const row = input.execution
  const effective = object(row?.effective)
  if (row && (row.hostId !== 'local' || row.threadId !== input.threadId)) return
  if (row?.modelSelection?.status === 'unknown') throw new Error('RESUME_SELECTION_UNCONFIRMED')
  const explicit = row?.modelSelection?.status === 'confirmed' ? selection(row.modelSelection) : undefined
  const confirmed = explicit ?? (row?.application === 'applied'
      && (row.appliedRevision === undefined || row.appliedRevision === row.revision)
    ? selection({ providerId: effective.modelProvider, model: effective.model })
    : undefined)
  const channel = await document(path.join(input.profileDirectory, 'channel-conversations.json'))
  const tasks = object(channel.taskSettings)
  const settings = Object.hasOwn(tasks, input.threadId) ? tasks[input.threadId] : undefined
  const entry = object(settings)
  const bound = Object.values(object(channel.bindings)).some(value => {
    const binding = object(value)
    return binding.state === 'active' && binding.sessionId === input.threadId
  })
  let requested: Selection | undefined
  if (settings !== undefined) {
    if (entry.application === 'unknown' && selection(entry.settings)) {
      throw new Error('RESUME_SELECTION_UNCONFIRMED')
    }
    const pending = object(entry.pendingPatch)
    if (pending.providerId !== undefined || pending.model !== undefined) {
      throw new Error('RESUME_SELECTION_UNCONFIRMED')
    }
    if (entry.application !== 'applied' || entry.pending !== undefined || entry.pendingPatch !== undefined) return
    requested = selection(entry.settings)
  } else if (bound) {
    return
  } else if (explicit) {
    requested = explicit
  } else {
    // Previous local migrations already carry an explicit applied selection. An
    // absent migration is normal for newer, independently confirmed threads.
    const legacy = await document(path.join(input.profileDirectory, 'history-provider-overrides.json'))
    if (legacy.schema === 'cordisx.history-provider-overrides/v1') {
      const entries = object(legacy.entries)
      const saved = Object.hasOwn(entries, input.threadId) ? object(entries[input.threadId]) : {}
      if (Object.keys(saved).length) {
        if (saved.status !== 'applied') throw new Error('RESUME_SELECTION_UNCONFIRMED')
        requested = selection(saved)
        if (!requested) return
      }
    }
    requested ??= confirmed
  }
  if (
    requested && (!confirmed || requested.providerId !== confirmed.providerId || requested.model !== confirmed.model)
  ) {
    throw new Error('RESUME_SELECTION_UNCONFIRMED')
  }
  return requested && confirmed && requested.providerId === confirmed.providerId && requested.model === confirmed.model
    ? requested
    : undefined
}
