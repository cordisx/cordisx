import type { CordisXTaskReadInput } from '../contracts.js'
import {
  AgentLoopAuthority,
  type AgentLoopAuthorityScope,
  agentLoopCommandDigest,
  type AgentLoopProviderFence,
  type AgentLoopTaskLocator,
} from '../launcher/agent-loop-authority.js'

import { copy } from './fleet-results.js'
export interface AgentLoopInFlight {
  readonly commandDigest: string
  readonly kind: string
  readonly provider: AgentLoopProviderFence
  readonly promise: Promise<unknown>
  readonly task?: string
  readonly lifecycleFence?: number
}

export async function runFleetAgentLoopTransaction(
  authority: AgentLoopAuthority | undefined,
  inFlight: Map<string, AgentLoopInFlight>,
  lifecycleQueue: () => Promise<void>,
  cursor: (session: CordisXTaskReadInput['session']) => number,
  input: { readonly scope: AgentLoopAuthorityScope; readonly command: unknown; readonly operationId: string },
  provider: AgentLoopProviderFence,
  execute: (commandDigest: string) => Promise<unknown>,
  resource?: { readonly resourceKey: string; readonly conflictCode: 'approval-conflict' | 'introduction-conflict' },
): Promise<unknown> {
  if (authority === undefined) return { status: 'unavailable', code: 'reconciliation-required' }
  const commandDigest = agentLoopCommandDigest(input.command)
  const kind = typeof (input.command as { type?: unknown } | null)?.type === 'string'
    ? String((input.command as { type: string }).type)
    : 'unknown'
  const inFlightKey = JSON.stringify([input.scope.profileId, input.scope.ownerKey, input.operationId])
  const replay = (value: unknown): unknown =>
    (value as { status?: unknown } | null)?.status === 'accepted'
      ? { ...(copy(value) as Record<string, unknown>), delivery: 'replayed' }
      : copy(value)
  const prior = inFlight.get(inFlightKey)
  if (prior !== undefined) {
    if (
      prior.provider.providerId !== provider.providerId
      || prior.provider.providerGeneration !== provider.providerGeneration
    ) {
      return { status: 'unavailable', code: 'provider-replaced' }
    }
    if (prior.commandDigest !== commandDigest || prior.kind !== kind) {
      return { status: 'conflict', code: 'operation-conflict' }
    }
    return replay(await prior.promise)
  }
  let resolve!: (value: unknown) => void
  let reject!: (error: unknown) => void
  const pending = new Promise<unknown>((accepted, failed) => {
    resolve = accepted
    reject = failed
  })
  void pending.catch(() => undefined)
  const locator = 'task' in provider && 'remoteSessionId' in provider ? provider as AgentLoopTaskLocator : undefined
  const operation: AgentLoopInFlight = {
    commandDigest,
    kind,
    provider: { providerId: provider.providerId, providerGeneration: provider.providerGeneration },
    promise: pending,
    ...(locator === undefined ? {} : {
      task: locator.task,
      lifecycleFence: cursor({ providerId: locator.providerId, remoteSessionId: locator.remoteSessionId }),
    }),
  }
  inFlight.set(inFlightKey, operation)
  try {
    // A provider terminal notification may have arrived immediately before
    // this command. Reconcile its durable introduction state before claiming
    // the same semantic resource for a retry.
    await lifecycleQueue()
    const plan = await authority.plan({
      scope: input.scope,
      operationId: input.operationId,
      commandDigest,
      kind,
      provider,
      ...(resource === undefined ? {} : { resourceKey: resource.resourceKey }),
    })
    let output: unknown
    if (plan.status === 'replay') output = replay(plan.result)
    else if (plan.status === 'conflict') output = { status: 'conflict', code: 'operation-conflict' }
    else if (plan.status === 'resource-conflict') {
      output = { status: 'conflict', code: resource?.conflictCode ?? 'operation-conflict' }
    } else if (plan.status === 'operation-expired') output = { status: 'unavailable', code: 'operation-expired' }
    else if (plan.status === 'reconciliation-required') {
      output = plan.provider !== undefined
          && (plan.provider.providerId !== provider.providerId
            || plan.provider.providerGeneration !== provider.providerGeneration)
        ? { status: 'unavailable', code: 'provider-replaced' }
        : { status: 'unavailable', code: 'reconciliation-required' }
    } else {
      const result = await execute(commandDigest)
      await authority.commit({
        scope: input.scope,
        operationId: input.operationId,
        commandDigest,
        result,
      })
      output = { ...(copy(result) as Record<string, unknown>), delivery: 'executed' }
    }
    resolve(output)
    return output
  } catch (error) {
    reject(error)
    throw error
  } finally {
    if (inFlight.get(inFlightKey) === operation) inFlight.delete(inFlightKey)
  }
}
