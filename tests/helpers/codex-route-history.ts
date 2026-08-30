import type {
  CodexRouteHistoryAdapter,
  CodexRouteHistoryEntry,
  CodexRouteHistorySnapshot,
} from '../../packages/cli/src/renderer/codex-router-history.js'

export class TestCodexRouteHistory implements CodexRouteHistoryAdapter {
  private readonly entries: CodexRouteHistorySnapshot[] = [{ available: true, key: 'native-0', index: 0 }]
  private readonly listeners = new Set<() => void>()
  private cursor = 0
  private sequence = 0

  snapshot(): CodexRouteHistorySnapshot {
    return this.entries[this.cursor]!
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  push(entry: CodexRouteHistoryEntry): CodexRouteHistorySnapshot {
    const next = Object.freeze({ available: true, key: `cordisx-${++this.sequence}`, index: this.cursor + 1, entry })
    this.entries.splice(this.cursor + 1, this.entries.length, next)
    this.cursor += 1
    return next
  }

  replace(entry?: CodexRouteHistoryEntry): CodexRouteHistorySnapshot {
    const next = Object.freeze({
      available: true,
      key: `cordisx-${++this.sequence}`,
      index: this.cursor,
      ...(entry === undefined ? {} : { entry }),
    })
    this.entries[this.cursor] = next
    return next
  }

  async go(delta: -1 | 1): Promise<CodexRouteHistorySnapshot> {
    const next = this.cursor + delta
    if (next < 0 || next >= this.entries.length) throw new Error(`Test Codex history cannot go(${delta})`)
    this.cursor = next
    for (const listener of [...this.listeners]) listener()
    return this.snapshot()
  }

  async nativeForward(): Promise<void> {
    await this.go(1)
  }

  dispose(): void {
    this.listeners.clear()
  }
}
