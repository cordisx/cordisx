import { type CdpSession, evaluateRuntimeOperation } from './cdp-session.js'
import {
  type DesktopManagerConfigProof,
  desktopManagerConfigProofExpression,
  evaluateRendererConfig,
  type RendererConfigOperation,
  type RendererConfigResult,
} from './renderer-config-management.js'

/** Runs configuration operations in the sole admitted Desktop renderer under its owner's fence. */
export class CdpRendererConfiguration {
  constructor(
    private readonly sessions: ReadonlySet<CdpSession>,
    private readonly reserve: () => (() => void) | undefined,
  ) {}

  async pluginConfiguration(operation: RendererConfigOperation): Promise<RendererConfigResult> {
    const release = this.reserve()
    if (!release) return { status: 'unavailable', reason: 'renderer-busy' }
    const mutation = operation.action === 'update' || operation.action === 'update-service'
    try {
      if (this.sessions.size !== 1) {
        return {
          status: 'unavailable',
          reason: this.sessions.size === 0 ? 'renderer-unavailable' : 'renderer-ambiguous',
        }
      }
      const session = [...this.sessions][0]!
      const result = await evaluateRendererConfig(session, operation)
      if (!this.sessions.has(session)) {
        return { status: mutation ? 'unknown' : 'unavailable', reason: 'renderer-disconnected' }
      }
      return result
    } catch {
      return { status: mutation ? 'unknown' : 'unavailable', reason: 'renderer-operation-failed' }
    } finally {
      release()
    }
  }

  async managerConfigProof(pluginId: string): Promise<DesktopManagerConfigProof | undefined> {
    const release = this.reserve()
    if (!release) return undefined
    try {
      if (this.sessions.size !== 1) return undefined
      const session = [...this.sessions][0]!
      const proof = await evaluateRuntimeOperation<DesktopManagerConfigProof | undefined>(
        session,
        desktopManagerConfigProofExpression(pluginId),
        30_000,
      )
      return this.sessions.has(session) ? proof : undefined
    } catch {
      return undefined
    } finally {
      release()
    }
  }
}
