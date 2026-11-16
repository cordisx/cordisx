import type { CardActionEvent } from '@larksuiteoapi/node-sdk'

/** Acknowledge the SDK callback before doing native work or replacing the clicked card. */
export class FeishuCardActionQueue {
  private readonly queued: CardActionEvent[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private stopped = false

  constructor(
    private readonly handle: (event: CardActionEvent) => Promise<void>,
    private readonly failure: (phase: string, error?: unknown) => void,
  ) {}

  enqueue(event: CardActionEvent): void {
    if (this.stopped) return
    if (this.queued.length >= 128) {
      this.failure('card-action-queue-full')
      return
    }
    // Transport raw bodies never enter this lifecycle queue.
    this.queued.push({
      messageId: event.messageId,
      chatId: event.chatId,
      operator: { ...event.operator },
      action: { ...event.action },
    })
    this.schedule()
  }

  private schedule(): void {
    if (this.stopped || !this.queued.length || this.timer || this.running) return
    // Promise microtasks still run inside the awaited SDK callback. A timer lets
    // its dispatcher finish and send the WebSocket acknowledgement first.
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.running = this.drain().finally(() => {
        this.running = undefined
        this.schedule()
      })
    }, 0)
    this.timer.unref()
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.queued.length) {
      const event = this.queued.shift()!
      try {
        await this.handle(event)
      } catch (error) {
        this.failure('card-action-failed', error)
      }
    }
  }

  async dispose(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.queued.length = 0
    await this.running
  }
}
