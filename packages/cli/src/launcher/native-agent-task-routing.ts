import { randomUUID } from 'node:crypto'
import type { NativeMarkedRequest, NativeSubmissionController } from './native-submission-controller.js'

type Route = {
  callId: string
  sourceThreadId: string
  token: string
  providerId: string
  model: string
  resumeToken: string
  configOverrides: Readonly<Record<string, unknown>>
  phase: 'start' | 'turn' | 'complete' | 'uncertain'
  threadId?: string
  requestId?: string | number
  authorized?: boolean
}
const valid = (value: unknown): value is string => typeof value === 'string' && /^[^\0\r\n]{1,512}$/u.test(value)

/** A private operation token follows one admitted native creation, never the next global request. */
export class NativeAgentTaskRouting {
  private readonly routes = new Map<string, Route>()
  private closed = false
  confirmed(callId: string, threadId: string): boolean {
    return [...this.routes.values()].some(route =>
      route.callId === callId && route.threadId === threadId && route.phase === 'complete'
    )
  }
  claimed(callId: string): boolean {
    return [...this.routes.values()].some(route => route.callId === callId && route.phase !== 'uncertain')
  }
  /** The native thread retains its credential binding; only transient completed routing is retired. */
  retireCompleted(callId: string): void {
    for (const [token, route] of this.routes) {
      if (route.callId === callId && route.phase === 'complete') this.routes.delete(token)
    }
  }
  constructor(
    private readonly controller: NativeSubmissionController,
    private readonly validate: (selection: { providerId: string; model: string }) => Promise<boolean> = async () =>
      true,
  ) {}

  async prepare(input: { callId: string; sourceThreadId: string; providerId: string; model: string }) {
    if (this.closed || !Object.values(input).every(valid) || this.routes.size >= 128) {
      throw new Error('Native task routing unavailable')
    }
    const prepared = await this.controller.prepareThreadResume({
      threadId: input.sourceThreadId,
      providerId: input.providerId,
      model: input.model,
    })
    if (prepared.kind !== 'resume') throw new Error('Native task credentials unavailable')
    if (this.closed) {
      await this.controller.completeThreadResume({
        threadId: input.sourceThreadId,
        resumeToken: prepared.resumeToken,
        succeeded: false,
      })
      throw new Error('Native task routing retired')
    }
    const token = randomUUID()
    this.routes.set(token, { ...input, token, ...prepared, phase: 'start' })
    return { token, model: input.model }
  }

  async consume(request: NativeMarkedRequest): Promise<unknown | undefined> {
    const route = this.routes.get(request.operationToken)
    if (!route) return undefined
    if (this.closed) return { kind: 'reject', reason: 'unknown-token' }
    if (!await this.validate(route)) {
      route.phase = 'uncertain'
      return { kind: 'reject', reason: 'selection-outside-catalog' }
    }
    if (route.requestId !== undefined || route.phase === 'uncertain' || route.phase === 'complete') {
      return { kind: 'reject', reason: 'request-mismatch' }
    }
    if (
      route.phase === 'start'
        ? request.method !== 'thread/start' || request.threadId !== undefined
        : request.method !== 'turn/start' || request.threadId !== route.threadId
    ) return { kind: 'reject', reason: 'request-mismatch' }
    route.requestId = request.requestId
    route.authorized = false
    return {
      kind: 'dispatch',
      agentTask: true,
      model: route.model,
      providerId: route.providerId,
      configOverrides: route.configOverrides,
    }
  }

  async authorize(token: string, requestId: string | number): Promise<boolean | undefined> {
    const route = this.routes.get(token)
    if (!route) return undefined
    if (this.closed) return false
    if (
      route.requestId !== requestId || route.phase === 'uncertain' || route.authorized || !await this.validate(route)
    ) return false
    route.authorized = true
    return true
  }

  async complete(input: {
    operationToken: string
    requestId: string | number
    succeeded: boolean
    boundThreadId?: string
    providerId?: string
    model?: string
  }): Promise<boolean> {
    const route = this.routes.get(input.operationToken)
    if (!route) return false
    if (route.requestId !== input.requestId || route.authorized !== true) return true
    if (!input.succeeded) {
      route.phase = 'uncertain'
      return true
    }
    if (route.phase === 'start' && valid(input.boundThreadId)) {
      if (input.providerId !== route.providerId || input.model !== route.model) {
        route.phase = 'uncertain'
        return true
      }
      route.threadId = input.boundThreadId
      // Native credentials are bound to the returned id, not the calling task.
      const committed = await this.controller.completeThreadResume({
        threadId: route.sourceThreadId,
        createdThreadId: route.threadId,
        resumeToken: route.resumeToken,
        succeeded: true,
      })
      if (!committed) {
        route.phase = 'uncertain'
        return true
      }
      route.phase = 'turn'
      delete route.requestId
      delete route.authorized
    } else if (route.phase === 'turn') route.phase = 'complete'
    else route.phase = 'uncertain'
    return true
  }

  async close() {
    this.closed = true
    for (const route of this.routes.values()) {
      await this.controller.completeThreadResume({
        threadId: route.sourceThreadId,
        resumeToken: route.resumeToken,
        succeeded: false,
      }).catch(() => undefined)
    }
    this.routes.clear()
  }
}
