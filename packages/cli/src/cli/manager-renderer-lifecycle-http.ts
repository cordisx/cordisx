import type { PluginManagementRpcOperation } from '../launcher/management-rpc.js'
import type { createManagerRendererBootstrap } from './manager-renderer-bootstrap.js'
import type { ManagerRendererGatewayProof } from './manager-renderer-gateway.js'
import type { createManagerRendererGraphSession } from './manager-renderer-graph-session.js'
import type { ManagerRendererHandle } from './manager-renderer-sessions.js'
import { ManagerLifecyclePolls } from './manager-lifecycle-polls.js'

type LifecycleSession = {
  readonly id: string
  readonly controller: AbortController
  readonly rendererCommands: boolean
  readonly rendererOpen?: Promise<ManagerRendererHandle | undefined>
  readonly rendererBootstrap?: ReturnType<typeof createManagerRendererBootstrap>
  readonly graphs?: ReturnType<typeof createManagerRendererGraphSession>
  lifecyclePolls?: ManagerLifecyclePolls
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Owner-scoped HTTP transport for lifecycle admission, polling, and receipts. */
export async function handleManagerRendererLifecycleHttp(input: {
  readonly path: string
  readonly body: Record<string, unknown>
  readonly session: LifecycleSession
  readonly gateway: ManagerRendererGatewayProof | undefined
  readonly active: () => boolean
  readonly request: (operation: PluginManagementRpcOperation, mutation: boolean) => Promise<unknown>
  readonly send: (status: number, value: unknown) => void
  readonly reply: (value: unknown) => void
  readonly revoked: () => void
  readonly retire: () => Promise<unknown>
}): Promise<boolean> {
  const { path, body, session } = input
  const error = (status: number, code: string) => {
    input.send(status, { error: code })
    return true
  }
  if (path === '/api/renderer/poll-recover') {
    if (
      !session.rendererCommands || !session.rendererBootstrap || Object.keys(body).length !== 1
      || !Number.isSafeInteger(body.pollSequence) || Number(body.pollSequence) < 1
    ) return error(400, 'INVALID_REQUEST')
    session.lifecyclePolls ??= new ManagerLifecyclePolls()
    const recovered = await session.lifecyclePolls.recover(
      Number(body.pollSequence),
      session.controller.signal,
      async () => input.active() && await session.rendererBootstrap!.isSessionCurrent() && input.active(),
    )
    input.reply({ recovered })
    return true
  }
  if (!['/api/renderer/admit', '/api/renderer/poll', '/api/renderer/acknowledge'].includes(path)) return false
  const gateway = input.gateway
  const open = session.rendererOpen
  if (!session.rendererCommands || open === undefined || gateway === undefined) {
    return error(503, 'RENDERER_COMMANDS_UNAVAILABLE')
  }
  const action = path.slice('/api/renderer/'.length)
  if (
    action === 'admit' && Object.keys(body).length !== 0
    || action === 'poll' && (Object.keys(body).some(key => !['timeoutMs', 'pollSequence'].includes(key))
        || !Object.hasOwn(body, 'timeoutMs')
        || Object.hasOwn(body, 'pollSequence')
          && (!Number.isSafeInteger(body.pollSequence) || Number(body.pollSequence) < 1)
        || !Number.isSafeInteger(body.timeoutMs) || Number(body.timeoutMs) < 1 || Number(body.timeoutMs) > 30_000)
    || action === 'acknowledge' && (Object.keys(body).length !== 1
        || !Object.hasOwn(body, 'receipt') || Buffer.byteLength(JSON.stringify(body)) > 196 * 1024)
  ) return error(400, 'INVALID_REQUEST')
  let poll: ReturnType<ManagerLifecyclePolls['begin']> = undefined
  if (action === 'poll') {
    session.lifecyclePolls ??= new ManagerLifecyclePolls()
    poll = session.lifecyclePolls.begin(Object.hasOwn(body, 'pollSequence') ? Number(body.pollSequence) : undefined)
    if (!poll) return error(409, 'POLL_SEQUENCE_UNAVAILABLE')
  }
  try {
    const handle = await open
    if (!input.active()) {
      input.revoked()
      return true
    }
    if (handle === undefined) return error(503, 'RENDERER_UNAVAILABLE')
    const common = { kind: 'manager-renderer' as const, gateway, browserSessionId: session.id, handle }
    const operation: PluginManagementRpcOperation = action === 'admit'
      ? { ...common, action: 'admit' }
      : action === 'poll'
      ? { ...common, action: 'poll', timeoutMs: Number(body.timeoutMs) }
      : { ...common, action: 'acknowledge', receipt: body.receipt }
    const result = object(await input.request(operation, true))
    if (result?.status === 'unknown') {
      await input.retire()
      return error(503, 'OPERATION_RESULT_UNKNOWN')
    }
    if (result?.status !== 'ok') return error(503, 'RENDERER_COMMANDS_UNAVAILABLE')
    if (action === 'poll') {
      const value = object(result.value)
      if (!value || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'command')) {
        throw new Error('invalid')
      }
      poll?.finish(value.command === null ? 'empty' : 'offered')
      input.reply({ command: value.command === null ? null : session.graphs!.projectCommand(value.command) })
      return true
    }
    if (action === 'acknowledge') {
      session.graphs!.acknowledge(body.receipt)
      session.lifecyclePolls?.acknowledge()
    }
    input.reply(result.value)
    return true
  } catch {
    await input.retire()
    return error(503, 'OPERATION_RESULT_UNKNOWN')
  } finally {
    poll?.finish('failed')
  }
}
