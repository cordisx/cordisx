import { type ChatExecutionSettings, observedExecutionSettings } from '../chat-execution-settings.js'
import type { NativeSourceConfiguration } from './native-source-configuration.js'
import { isDeepStrictEqual } from 'node:util'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
// Native Codex may materialize an explicitly inherited normal tier as "default".
const matchesServiceTier = (actual: unknown, expected: unknown): boolean =>
  actual === 'priority' ? expected === 'priority' : (actual === null || actual === 'default')
    && (expected === null || expected === 'default')

export interface ContinuationConfiguration {
  readonly providerId: string
  readonly model: string
  readonly cwd: string
  readonly execution: ChatExecutionSettings
  readonly serviceTier: 'default' | 'priority' | null
  readonly permissions?: string
  readonly approvalsReviewer: string
  readonly sandbox: Record<string, unknown>
  readonly permissionProfile: unknown
}

/** Fail closed where exact effective execution settings cannot be reproduced. */
export function continuationConfiguration(
  effective: Record<string, unknown> | undefined,
  live: NativeSourceConfiguration | undefined,
  confirmedWorkMode?: 'default' | 'plan',
): ContinuationConfiguration | undefined {
  if (!effective || !Object.hasOwn(effective, 'activePermissionProfile')) return undefined
  if (live && (effective.modelProvider !== live.providerId || effective.model !== live.model)) return undefined
  const providerId = live?.providerId ?? effective.modelProvider
  const model = live?.model ?? effective.model
  const observedEffort = live?.reasoningEffort ?? effective.reasoningEffort
  // A native null is an observed inherited choice; an absent field remains unknown.
  const effort = observedEffort === null ? 'inherit' : observedEffort
  const serviceTier = live ? live.serviceTier : effective.serviceTier
  const cwd = effective.cwd
  const profile = effective.activePermissionProfile
  if (profile === undefined || profile !== null && (typeof profile !== 'object' || Array.isArray(profile))) {
    return undefined
  }
  const permissions = profile === null || profile === undefined ? undefined : object(profile).id
  const sandbox = object(effective.sandbox)
  const settings = observedExecutionSettings(effective)
  if (settings.workMode && confirmedWorkMode && settings.workMode !== confirmedWorkMode) return undefined
  const workMode = settings.workMode ?? confirmedWorkMode
  if (
    typeof providerId !== 'string' || !providerId || typeof model !== 'string' || !model
    || typeof cwd !== 'string' || !cwd.startsWith('/') || typeof effort !== 'string'
    || !['readOnly', 'workspaceWrite', 'dangerFullAccess'].includes(String(sandbox.type))
    || (serviceTier !== null && serviceTier !== 'priority' && serviceTier !== 'default')
    || !['user', 'auto_review', 'guardian_subagent'].includes(String(effective.approvalsReviewer))
    || (profile !== null && (typeof permissions !== 'string' || !permissions))
    || settings.approval === undefined || workMode === undefined
    || (permissions === undefined && settings.execution === undefined)
  ) return undefined
  if (permissions === undefined && sandbox.type === 'workspaceWrite') {
    if (
      !Array.isArray(sandbox.writableRoots) || sandbox.writableRoots.length > 1
      || (sandbox.writableRoots.length === 1 && sandbox.writableRoots[0] !== cwd)
      || sandbox.excludeTmpdirEnvVar === true || sandbox.excludeSlashTmp === true
    ) return undefined
  }
  if (permissions === undefined && sandbox.type === 'readOnly' && sandbox.networkAccess === true) return undefined
  return {
    providerId,
    model,
    cwd,
    serviceTier,
    approvalsReviewer: String(effective.approvalsReviewer),
    sandbox,
    permissionProfile: profile,
    ...(typeof permissions === 'string' ? { permissions } : {}),
    execution: {
      approval: settings.approval,
      workMode,
      effort,
      ...(permissions === undefined && settings.execution !== undefined ? { execution: settings.execution } : {}),
      ...(permissions === undefined && settings.networkAccess !== undefined
        ? { networkAccess: settings.networkAccess }
        : {}),
    },
  }
}

/** The fresh native thread must confirm the same security and model settings before its first turn. */
export function continuationStartMatches(value: unknown, expected: unknown): boolean {
  const started = object(value), requested = object(expected), execution = object(requested.execution)
  return typeof requested.providerId === 'string' && started.modelProvider === requested.providerId
    && typeof requested.model === 'string' && started.model === requested.model
    && typeof requested.cwd === 'string' && started.cwd === requested.cwd
    && Object.hasOwn(requested, 'serviceTier') && matchesServiceTier(started.serviceTier, requested.serviceTier)
    && started.approvalsReviewer === requested.approvalsReviewer && started.approvalPolicy === execution.approval
    && (execution.effort === 'inherit'
      ? started.reasoningEffort === null
        || typeof started.reasoningEffort === 'string' && started.reasoningEffort.length > 0
      : started.reasoningEffort === execution.effort)
    && isDeepStrictEqual(started.sandbox, requested.sandbox)
    && isDeepStrictEqual(started.activePermissionProfile, requested.permissionProfile)
}
