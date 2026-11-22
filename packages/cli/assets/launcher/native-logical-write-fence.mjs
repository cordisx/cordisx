import { randomUUID } from 'node:crypto'

const reads = new Set(['thread/read', 'thread/items/list', 'thread/turns/list', 'thread/list', 'model/list'])
const key = id => typeof id + ':' + String(id)

/** Tracks native writes until their actual response, including after a caller timeout. */
export class NativeLogicalWriteFence {
  #writes = new Map()
  #leases = new Map()
  #turns = new Map()
  #persisted = new Set()
  #persistedRevision = -1
  #uncertain = false

  restore(revision, sources) {
    if (
      !Number.isSafeInteger(revision) || revision < 0 || revision < this.#persistedRevision
      || !Array.isArray(sources) || sources.length > 4096
      || sources.some(source =>
        typeof source !== 'string' || !source || source.length > 512
        || /[\0\r\n]/u.test(source)
      ) || new Set(sources).size !== sources.length
    ) return false
    const next = new Set(sources)
    if (revision === this.#persistedRevision) {
      return next.size === this.#persisted.size && [...next].every(source => this.#persisted.has(source))
    }
    for (const source of next) {
      if (this.#turns.has(source) || [...this.#writes.values()].some(write => write.threadId === source)) {
        this.#uncertain = true
      }
    }
    this.#persisted = next
    this.#persistedRevision = revision
    return true
  }
  owns(threadId, lease) {
    return !this.#uncertain && !this.#turns.has(threadId)
      && typeof lease === 'string' && this.#leases.get(threadId) === lease
  }
  acquire(threadId) {
    if (
      this.#uncertain || this.#leases.has(threadId) || this.#turns.has(threadId) || this.#persisted.has(threadId)
      || [...this.#writes.values()].some(write => write.threadId === threadId)
    ) return undefined
    const lease = randomUUID()
    this.#leases.set(threadId, lease)
    return lease
  }
  canAbandon(sources) {
    return !this.#uncertain && Array.isArray(sources) && sources.length > 0 && sources.length <= 2
      && new Set(sources).size === sources.length
      && sources.every(source =>
        typeof source === 'string' && this.#persisted.has(source)
        && !this.#leases.has(source) && !this.#turns.has(source)
        && ![...this.#writes.values()].some(write => write.threadId === source)
      )
  }
  release(threadId, lease) {
    if (
      this.#uncertain || this.#leases.get(threadId) !== lease || this.#turns.has(threadId)
      || this.#persisted.has(threadId)
      || [...this.#writes.values()].some(write => write.threadId === threadId)
    ) {
      return false
    }
    this.#leases.delete(threadId)
    return true
  }
  enter(message, lease, sourceThreadId) {
    if (typeof message?.method !== 'string') return
    const threadId = sourceThreadId ?? message?.params?.threadId
    const writing = typeof threadId === 'string' && !reads.has(message.method)
    const owner = writing ? this.#leases.get(threadId) : undefined
    if ((owner || writing && this.#persisted.has(threadId)) && (!owner || owner !== lease)) {
      throw Object.assign(new Error('Native continuation pending'), { code: 'CONTINUATION_PENDING' })
    }
    if (
      !['string', 'number'].includes(typeof message.id) || this.#writes.has(key(message.id))
      || this.#writes.size >= 4096
    ) {
      if (writing || message.id !== undefined) this.#uncertain = true
      if (owner) throw Object.assign(new Error('Native continuation pending'), { code: 'CONTINUATION_PENDING' })
      return
    }
    this.#writes.set(key(message.id), {
      threadId: writing ? threadId : undefined,
      method: message.method,
      completed: new Set(),
    })
  }
  complete(message) {
    if (message?.method === 'turn/started' || message?.method === 'turn/completed') {
      const threadId = message.params?.threadId
      const turnId = message.params?.turn?.id
      if (typeof threadId !== 'string' || typeof turnId !== 'string') {
        this.#uncertain = true
        return
      }
      if (message.method === 'turn/started') {
        if (this.#leases.has(threadId)) this.#uncertain = true
        this.#addTurn(threadId, turnId)
      } else {
        this.#removeTurn(threadId, turnId)
        for (const write of this.#writes.values()) {
          if (write.threadId === threadId && write.method === 'turn/start') {
            if (write.completed.size >= 4096) this.#uncertain = true
            else write.completed.add(turnId)
          }
        }
      }
      return
    }
    if (message?.method === undefined && ['string', 'number'].includes(typeof message?.id)) {
      const write = this.#writes.get(key(message.id))
      if (write?.method === 'turn/start' && write.threadId && !message.error) {
        const turn = message.result?.turn
        if (typeof turn?.id !== 'string') this.#uncertain = true
        else if (!write.completed.has(turn.id) && !['completed', 'failed', 'interrupted'].includes(turn.status)) {
          this.#addTurn(write.threadId, turn.id)
        }
      }
      this.#writes.delete(key(message.id))
    }
  }
  uncertain(id) {
    if (this.#writes.get(key(id))?.threadId !== undefined) this.#uncertain = true
  }
  #addTurn(threadId, turnId) {
    if (this.#turns.size >= 4096 && !this.#turns.has(threadId)) {
      this.#uncertain = true
      return
    }
    const turns = this.#turns.get(threadId) ?? new Set()
    if (turns.size >= 4096 && !turns.has(turnId)) this.#uncertain = true
    else turns.add(turnId)
    this.#turns.set(threadId, turns)
  }
  #removeTurn(threadId, turnId) {
    const turns = this.#turns.get(threadId)
    turns?.delete(turnId)
    if (turns?.size === 0) this.#turns.delete(threadId)
  }
}

/** A blocked Desktop request must receive an error without stopping the intermediary. */
export async function forwardWithLogicalFence(line, forward, writeDesktop) {
  try {
    await forward(line)
  } catch (error) {
    if (error?.code !== 'CONTINUATION_PENDING') throw error
    const message = JSON.parse(line)
    if (message.id !== undefined) {
      await writeDesktop({
        id: message.id,
        error: { code: -32000, message: 'Continuation is pending; check the conversation state.' },
      })
    }
  }
}

/** Private control messages are accepted only from the authenticated launch owner. */
export function dispatchLogicalFence(message, fence, respond, stop) {
  if (message.type === 'logical-fence-restore' && typeof message.id === 'string') {
    void respond({ id: message.id, ok: true, value: fence.restore(message.revision, message.sources) }).catch(stop)
    return true
  }
  if (message.type === 'logical-fence-can-abandon' && typeof message.id === 'string') {
    void respond({ id: message.id, ok: true, value: fence.canAbandon(message.sources) }).catch(stop)
    return true
  }
  if (typeof message.id !== 'string' || typeof message.threadId !== 'string') return false
  if (message.type === 'logical-fence-begin') {
    void respond({ id: message.id, ok: true, value: fence.acquire(message.threadId) ?? null }).catch(stop)
    return true
  }
  if (message.type === 'logical-fence-release' && typeof message.lease === 'string') {
    void respond({ id: message.id, ok: true, value: fence.release(message.threadId, message.lease) }).catch(stop)
    return true
  }
  return false
}
