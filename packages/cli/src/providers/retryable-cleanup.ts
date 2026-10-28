/** One explicit attempt at a time; successful participants are never repeated. */
export class RetryableCleanup {
  private readonly pending: Set<() => void | Promise<void>>
  private running: Promise<void> | undefined

  constructor(operations: readonly (() => void | Promise<void>)[], private readonly message: string) {
    this.pending = new Set(operations)
  }

  get completed(): boolean {
    return this.pending.size === 0
  }

  run(): Promise<void> {
    if (this.running !== undefined) return this.running
    const running = Promise.resolve().then(() => this.attempt())
    this.running = running
    void running.then(() => this.clear(running), () => this.clear(running))
    return running
  }

  private async attempt(): Promise<void> {
    const failures: unknown[] = []
    for (const operation of this.pending) {
      try {
        await operation()
        this.pending.delete(operation)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, this.message)
  }

  private clear(running: Promise<void>): void {
    if (this.running === running) this.running = undefined
  }
}

export function fleetCloseCleanup(
  controlledTurns: { dispose(): Promise<void> },
  disposers: Iterable<() => void>,
  registry: { dispose(): Promise<void> },
): RetryableCleanup {
  return new RetryableCleanup([
    async () => await controlledTurns.dispose(),
    ...disposers,
    async () => await registry.dispose(),
  ], 'Provider Fleet close failed')
}
