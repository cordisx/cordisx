/** One profile authority must not apply two reviews against the same activation concurrently. */
export class PermissionReviewBusyError extends Error {
  constructor() {
    super('Another plugin permission review is being applied.')
  }
}

export class PermissionReviewGate {
  private busy = false

  async run<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (this.busy) throw new PermissionReviewBusyError()
    this.busy = true
    try {
      return await operation()
    } finally {
      this.busy = false
    }
  }
}
