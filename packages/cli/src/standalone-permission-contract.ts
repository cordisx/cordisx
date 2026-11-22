/** Public protocol marker, never an owner credential or authorization grant. */
export const STANDALONE_PERMISSION_BINDING_MARKER = 'cordisx-standalone-session-v1'

export interface StandaloneDomPolicyAdoption {
  readonly requestId: string
  readonly origin: boolean
  readonly identity: { readonly id: string; readonly source: string }
  readonly moduleGeneration: string
  readonly expected: readonly unknown[]
  readonly updates: readonly unknown[]
  readonly candidate: readonly unknown[]
}

export type StandaloneDomPolicyAdopter = (input: StandaloneDomPolicyAdoption) => Promise<boolean>

const MANAGER_UI_POINTS = new Set(['manager.settings.navigation-items', 'manager.content'])
const RENDERER_ALIAS = /^https:\/\/renderer[.]cordisx[.]invalid\/plugin\/[a-f0-9]{64}$/u

/** The standalone review applies only to the configured Channel Manager UI. */
export function isStandaloneDomReviewTarget(
  identity: { readonly id: string; readonly source: string },
  pointId: string,
): boolean {
  return identity.id === 'channel' && RENDERER_ALIAS.test(identity.source) && MANAGER_UI_POINTS.has(pointId)
}
