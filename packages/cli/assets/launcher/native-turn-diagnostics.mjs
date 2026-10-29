import { createHash, randomUUID } from 'node:crypto'
const ref = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 20)
const name = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,128}$/u.test(value) ? value : 'unknown'

/** Observe only the existing intermediary frames. Never retain content, errors, config or headers. */
export class NativeTurnDiagnostics {
  constructor(emit, now = () => performance.now()) {
    this.emit = emit
    this.now = now
    this.requests = new Map()
    this.turns = new Map()
    this.selections = new Map()
  }
  event(entry, event, extra = {}) {
    try {
      this.emit({
        event,
        requestRef: entry.requestRef,
        threadRef: entry.threadRef,
        turnRef: entry.turnRef,
        provider: entry.provider,
        model: entry.model,
        elapsedMs: Math.round(this.now() - entry.started),
        ...extra,
      })
    } catch {}
  }
  bounded(map, key, value) {
    if (map.size >= 512 && !map.has(key)) {
      const oldest = map.keys().next().value
      this.event(map.get(oldest), 'model-evidence-gap', { reason: 'correlation-capacity' })
      map.delete(oldest)
    }
    map.set(key, value)
  }
  queued(message) {
    if (message?.method !== 'turn/start' || message.id === undefined) return
    const thread = ref(message.params?.threadId ?? 'unknown')
    const selected = this.selections.get(thread)
    const entry = {
      requestRef: randomUUID(),
      threadRef: thread,
      started: this.now(),
      provider: name(message.params?.modelProvider ?? selected?.provider),
      model: name(message.params?.model ?? selected?.model),
    }
    this.bounded(this.requests, message.id, entry)
    this.event(entry, 'model-queued', { support: 'upstream-http-timing-unsupported' })
  }
  selected(requestId, selection) {
    const entry = this.requests.get(requestId)
    if (entry) {
      entry.provider = name(selection.providerId)
      entry.model = name(selection.model)
    }
  }
  issued(message) {
    if (message?.method === 'turn/interrupt') {
      const thread = ref(message.params?.threadId ?? 'unknown')
      for (const entry of this.turns.values()) {
        if (entry.threadRef === thread) this.event(entry, 'model-cancel-requested')
      }
    }
    const entry = this.requests.get(message?.id)
    if (entry && message.method === 'turn/start') {
      if (message.params?.model) entry.model = name(message.params.model)
      if (message.params?.modelProvider) entry.provider = name(message.params.modelProvider)
      this.event(entry, 'model-issued')
    }
  }
  received(message) {
    const result = message?.result
    if (result?.thread?.id && (result.modelProvider || result.model)) {
      this.bounded(this.selections, ref(result.thread.id), {
        provider: name(result.modelProvider),
        model: name(result.model),
        requestRef: randomUUID(),
        started: this.now(),
      })
    }
    const request = message?.method === undefined ? this.requests.get(message?.id) : undefined
    if (request) {
      this.requests.delete(message.id)
      if (message.error) {
        this.event(request, 'model-failed', {
          reason: 'native-rpc-rejected',
          errorCode: Number.isSafeInteger(message.error.code) ? String(message.error.code) : 'unknown',
        })
      } else if (result?.turn?.id) {
        request.turnRef = ref(result.turn.id)
        this.bounded(this.turns, request.turnRef, request)
        this.event(request, 'model-accepted')
      } else this.event(request, 'model-evidence-gap', { reason: 'turn-association-unavailable' })
    }
    const params = message?.params
    const turn = params?.turn?.id ?? params?.turnId
    if (!turn) return
    const key = ref(turn), entry = this.turns.get(key)
    if (!entry) return
    if (!entry.first) {
      entry.first = true
      this.event(entry, 'model-first-event')
    }
    if (message.method === 'error') {
      this.event(entry, 'model-error', { reason: 'native-upstream-error', support: 'upstream-http-status-unsupported' })
    }
    if (message.method === 'turn/completed') {
      const status = params.turn?.status
      this.event(
        entry,
        status === 'completed' ? 'model-completed' : status === 'interrupted' ? 'model-cancelled' : 'model-failed',
        { reason: ['completed', 'interrupted', 'failed', 'inProgress'].includes(status) ? status : 'unknown' },
      )
      this.turns.delete(key)
    }
  }
  close() {
    for (const entry of [...this.requests.values(), ...this.turns.values()]) {
      this.event(entry, 'model-cancelled', { reason: 'transport-closed' })
    }
    this.requests.clear()
    this.turns.clear()
    this.selections.clear()
  }
}
