import type {
  AgentDetailNavigationRequest,
  AgentDetailNavigationResult,
  AgentSessionDetailReferenceRequest,
  AgentSessionDetailReferenceResult,
} from '@cordisx/protocol/agent-detail-navigation/v1'
import type { AgentSessionDetailReferenceResult as HistoricalReferenceResult } from '@cordisx/protocol/agent-detail-navigation/v2'
import type { PluginOwnerIdentity } from '@cordisx/protocol/sessions/v1'
import { AgentSessionRuntimeApproval } from './agent-session-runtime-approval.js'
import { clone, hasExactKeys, opaque, plainObject } from './agent-session-runtime-types.js'

/** Detail projection is separate from admission. The v1 methods remain current-only. */
export abstract class AgentSessionRuntimeDetails extends AgentSessionRuntimeApproval {
  async getAgentSessionDetailReference(
    owner: PluginOwnerIdentity,
    request: AgentSessionDetailReferenceRequest,
  ): Promise<AgentSessionDetailReferenceResult> {
    if (this.disposed) return { status: 'unavailable', code: 'host-unavailable' }
    if (
      !plainObject(request) || !hasExactKeys(request, ['sessionId'])
      || typeof request.sessionId !== 'string'
    ) return { status: 'unavailable', code: 'session-unavailable' }
    if (!opaque(request.sessionId)) return { status: 'unavailable', code: 'session-unavailable' }
    const record = this.agents.get(request.sessionId)
    if (record === undefined) return { status: 'unavailable', code: 'session-unavailable' }
    if (!this.sameOwner(owner, record.owner)) return { status: 'denied', code: 'permission-denied' }
    if (!this.current(record)) {
      return {
        status: 'unavailable',
        code: record.disposed === 'connection-replaced' ? 'connection-replaced' : 'generation-replaced',
      }
    }
    if (record.detail === undefined || !this.validAgentDetailReference(record.detail)) {
      return { status: 'unavailable', code: 'detail-unavailable' }
    }
    return { status: 'accepted', sessionId: record.id, target: Object.freeze(clone(record.detail)) }
  }

  async openAgentDetail(
    owner: PluginOwnerIdentity,
    request: AgentDetailNavigationRequest,
  ): Promise<AgentDetailNavigationResult> {
    if (this.disposed) return { status: 'unavailable', code: 'host-unavailable' }
    if (!plainObject(request) || !hasExactKeys(request, ['target'])) {
      return { status: 'unavailable', code: 'unknown-detail' }
    }
    if (!this.validAgentDetailReference(request.target)) return { status: 'unavailable', code: 'unknown-detail' }
    const candidates = [...this.agents.values()].filter(record =>
      this.sameOwner(owner, record.owner) && this.current(record) && record.detail !== undefined
      && this.sameAgentDetailReference(record.detail, request.target)
    )
    if (candidates.length > 1) return { status: 'denied', code: 'ambiguous-detail' }
    const record = candidates[0]
    if (record === undefined) return { status: 'unavailable', code: 'unknown-detail' }
    if (this.options.navigateAgentDetail === undefined) return { status: 'unavailable', code: 'unsupported' }
    try {
      await this.options.navigateAgentDetail(Object.freeze(clone(record.detail!)), record.id)
    } catch {
      return { status: 'unavailable', code: 'stale-reference' }
    }
    if (!this.current(record) || !this.sameOwner(owner, record.owner)) {
      return { status: 'unavailable', code: 'generation-replaced' }
    }
    return { status: 'accepted', code: 'opened' }
  }

  async getAgentSessionDetailReferenceV2(
    owner: PluginOwnerIdentity,
    request: AgentSessionDetailReferenceRequest,
  ): Promise<HistoricalReferenceResult> {
    if (this.disposed) return { status: 'unavailable', code: 'host-unavailable' }
    if (!plainObject(request) || !hasExactKeys(request, ['sessionId']) || !opaque(request.sessionId)) {
      return { status: 'unavailable', code: 'session-unavailable' }
    }
    const connection = this.connectionGeneration
    const active = () => !this.disposed && connection === this.connectionGeneration
    if (!await this.allowed(owner, 'sessions.get', request.sessionId)) {
      return { status: 'denied', code: 'permission-denied' }
    }
    if (!active()) return { status: 'unavailable', code: 'connection-replaced' }
    const record = this.agents.get(request.sessionId)
    // Durable source identity must match even when an old Agent generation remains in memory.
    if (record !== undefined && record.owner.pluginId !== owner.pluginId) {
      return { status: 'denied', code: 'permission-denied' }
    }
    if (
      record !== undefined && this.sameOwner(owner, record.owner) && this.current(record)
      && this.validAgentDetailReference(record.detail)
    ) {
      return await this.getAgentSessionDetailReference(owner, request)
    }
    // Disposed/ended or previous-generation Agents can still have an authorized
    // persisted mapping. The provider authenticates the current client afresh;
    // this does not reuse an old capability or revive an Agent handle.
    if (this.options.historicalAgentDetails === undefined) return { status: 'unavailable', code: 'unsupported' }
    return await this.options.historicalAgentDetails.get(owner, request.sessionId, active)
  }

  async openAgentDetailV2(
    owner: PluginOwnerIdentity,
    request: AgentDetailNavigationRequest,
  ): Promise<AgentDetailNavigationResult> {
    if (this.disposed) return { status: 'unavailable', code: 'host-unavailable' }
    if (
      !plainObject(request) || !hasExactKeys(request, ['target']) || !this.validAgentDetailReference(request.target)
    ) {
      return { status: 'unavailable', code: 'unknown-detail' }
    }
    const connection = this.connectionGeneration
    const active = () => !this.disposed && connection === this.connectionGeneration
    const candidates = [...this.agents.values()].filter(record =>
      this.sameOwner(owner, record.owner) && this.current(record) && record.detail !== undefined
      && this.sameAgentDetailReference(record.detail, request.target)
    )
    if (candidates.length > 1) return { status: 'denied', code: 'ambiguous-detail' }
    if (candidates.length === 1) {
      if (!await this.allowed(owner, 'sessions.get', candidates[0]!.id)) {
        return { status: 'denied', code: 'permission-denied' }
      }
      if (!active()) return { status: 'unavailable', code: 'connection-replaced' }
      return await this.openAgentDetail(owner, request)
    }
    if (this.options.historicalAgentDetails === undefined || this.options.navigateAgentDetail === undefined) {
      return { status: 'unavailable', code: 'unsupported' }
    }
    return await this.options.historicalAgentDetails.open(
      owner,
      request.target,
      active,
      sessionId => this.allowed(owner, 'sessions.get', sessionId),
      this.options.navigateAgentDetail,
    )
  }
}
