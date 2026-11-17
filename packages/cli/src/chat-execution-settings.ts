export interface ChatExecutionSettings {
  readonly execution?: 'inherit' | 'read-only' | 'workspace-write' | 'full-access'
  readonly approval?: 'inherit' | 'untrusted' | 'on-request' | 'never'
  readonly workMode?: 'inherit' | 'default' | 'plan'
  readonly effort?: string
  readonly networkAccess?: boolean
}

export interface ChatExecutionDefaults {
  readonly revision: number
  readonly settings: ChatExecutionSettings
}

/** A sparse layer inherits omitted fields and explicit inherit choices; false is an intentional value. */
export function mergeChatExecutionSettings(
  base: ChatExecutionSettings,
  overrides: ChatExecutionSettings,
): ChatExecutionSettings {
  return {
    ...base,
    ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined && value !== 'inherit')),
  }
}

/** Execution settings are separate from plugin capabilities and model-provider credentials. */
export function parseChatExecutionSettings(value: unknown): ChatExecutionSettings {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_EXECUTION_SETTINGS')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['execution', 'approval', 'workMode', 'effort', 'networkAccess'].includes(key))) {
    throw new Error('INVALID_EXECUTION_SETTINGS')
  }
  for (
    const [key, choices] of [
      ['execution', ['inherit', 'read-only', 'workspace-write', 'full-access']],
      ['approval', ['inherit', 'untrusted', 'on-request', 'never']],
      ['workMode', ['inherit', 'default', 'plan']],
    ] as const
  ) {
    if (row[key] !== undefined && !(choices as readonly unknown[]).includes(row[key])) {
      throw new Error('INVALID_EXECUTION_SETTINGS')
    }
  }
  if (
    row.effort !== undefined && (typeof row.effort !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/u.test(row.effort))
    || row.networkAccess !== undefined && typeof row.networkAccess !== 'boolean'
  ) throw new Error('INVALID_EXECUTION_SETTINGS')
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as ChatExecutionSettings
}

export function parseChatExecutionDefaults(value: unknown): ChatExecutionDefaults | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_EXECUTION_DEFAULTS')
  const row = value as Record<string, unknown>
  if (
    Object.keys(row).some(key => !['revision', 'settings'].includes(key)) || !Number.isSafeInteger(row.revision)
    || Number(row.revision) < 0
  ) throw new Error('INVALID_EXECUTION_DEFAULTS')
  return { revision: Number(row.revision), settings: parseChatExecutionSettings(row.settings) }
}

export function nativeExecutionStart(settings: ChatExecutionSettings): Record<string, unknown> {
  if (settings.execution === 'full-access' && settings.networkAccess === false) {
    throw new Error('EXECUTION_NETWORK_SCOPE_UNAVAILABLE')
  }
  const sandbox = settings.execution === 'full-access' ? 'danger-full-access' : settings.execution
  return {
    ...(sandbox === undefined || sandbox === 'inherit' ? {} : { sandbox }),
    ...(settings.approval === undefined || settings.approval === 'inherit'
      ? {}
      : { approvalPolicy: settings.approval }),
    ...((settings.effort === undefined || settings.effort === 'inherit') && settings.networkAccess === undefined
      ? {}
      : {
        config: {
          ...(settings.effort === undefined || settings.effort === 'inherit'
            ? {}
            : { model_reasoning_effort: settings.effort }),
          ...(settings.networkAccess === undefined
            ? {}
            : { 'sandbox_workspace_write.network_access': settings.networkAccess }),
        },
      }),
  }
}

export function nativeExecutionTurn(
  settings: ChatExecutionSettings,
  current: Record<string, unknown>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (settings.execution === 'full-access' && settings.networkAccess === false) {
    throw new Error('EXECUTION_NETWORK_SCOPE_UNAVAILABLE')
  }
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const sandbox = record(params.sandboxPolicy ?? current.sandbox)
  if (
    sandbox.type === 'dangerFullAccess' && settings.networkAccess === false
    && (settings.execution === undefined || settings.execution === 'inherit' || settings.execution === 'full-access')
  ) {
    throw new Error('EXECUTION_NETWORK_SCOPE_UNAVAILABLE')
  }
  const mode = settings.execution === undefined || settings.execution === 'inherit'
    ? settings.networkAccess === undefined
      ? undefined
      : sandbox.type === 'workspaceWrite'
      ? 'workspace-write'
      : sandbox.type === 'readOnly'
      ? 'read-only'
      : undefined
    : settings.execution
  const networkAccess = settings.networkAccess
    ?? (typeof sandbox.networkAccess === 'boolean' ? sandbox.networkAccess : false)
  const cwd = typeof params.cwd === 'string' ? params.cwd : current.cwd
  if (mode === 'workspace-write' && !Array.isArray(sandbox.writableRoots) && typeof cwd !== 'string') {
    throw new Error('EXECUTION_CONTEXT_UNAVAILABLE')
  }
  if (settings.networkAccess !== undefined && mode === undefined && sandbox.type !== 'dangerFullAccess') {
    throw new Error('EXECUTION_CONTEXT_UNAVAILABLE')
  }
  const sandboxPolicy = mode === 'full-access'
    ? { type: 'dangerFullAccess' }
    : mode === 'read-only'
    ? { type: 'readOnly', networkAccess }
    : mode === 'workspace-write'
    ? {
      type: 'workspaceWrite',
      writableRoots: sandbox.type === 'workspaceWrite' && Array.isArray(sandbox.writableRoots)
        ? sandbox.writableRoots
        : [cwd],
      networkAccess,
      excludeTmpdirEnvVar: sandbox.excludeTmpdirEnvVar === true,
      excludeSlashTmp: sandbox.excludeSlashTmp === true,
    }
    : undefined
  const effort = settings.effort === 'inherit' ? undefined : settings.effort
  let collaborationMode: unknown
  if (settings.workMode !== undefined && settings.workMode !== 'inherit') {
    const capturedMode = record(params.collaborationMode)
    const modeSettings = record(capturedMode.settings)
    const model = params.model ?? modeSettings.model ?? current.model
    if (typeof model !== 'string' || !model) throw new Error('WORK_MODE_MODEL_UNAVAILABLE')
    collaborationMode = {
      mode: settings.workMode,
      settings: {
        model,
        reasoning_effort: effort ?? modeSettings.reasoning_effort ?? current.reasoningEffort ?? null,
        developer_instructions: modeSettings.developer_instructions ?? null,
      },
    }
  } else if (effort !== undefined && params.collaborationMode) {
    const capturedMode = record(params.collaborationMode)
    collaborationMode = { ...capturedMode, settings: { ...record(capturedMode.settings), reasoning_effort: effort } }
  }
  return {
    ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
    ...(settings.approval === undefined || settings.approval === 'inherit'
      ? {}
      : { approvalPolicy: settings.approval }),
    ...(effort === undefined ? {} : { effort }),
    ...(collaborationMode === undefined ? {} : { collaborationMode }),
  }
}

/** Compare actual native readback, never an outgoing request, with the requested settings. */
export function executionSettingsMatch(settings: ChatExecutionSettings, effective: Record<string, unknown>): boolean {
  const sandbox = effective.sandbox as Record<string, unknown> | undefined
  const kinds = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'full-access': 'dangerFullAccess' }
  return (settings.execution === undefined || settings.execution === 'inherit'
    || sandbox?.type === kinds[settings.execution])
    && (settings.approval === undefined || settings.approval === 'inherit'
      || effective.approvalPolicy === settings.approval)
    && (settings.effort === undefined || settings.effort === 'inherit' || effective.reasoningEffort === settings.effort)
    && (settings.workMode === undefined || settings.workMode === 'inherit' || effective.workMode === settings.workMode)
    && (settings.networkAccess === undefined || sandbox?.type === 'dangerFullAccess' && settings.networkAccess === true
      || sandbox?.networkAccess === settings.networkAccess)
}

/** Only independently observed values become a display snapshot; missing values remain missing. */
export function observedExecutionSettings(effective: Record<string, unknown>): ChatExecutionSettings {
  const sandbox = effective.sandbox as Record<string, unknown> | undefined
  return {
    ...(sandbox?.type === 'dangerFullAccess'
      ? { execution: 'full-access' as const }
      : sandbox?.type === 'workspaceWrite'
      ? { execution: 'workspace-write' as const }
      : sandbox?.type === 'readOnly'
      ? { execution: 'read-only' as const }
      : {}),
    ...(['untrusted', 'on-request', 'never'].includes(String(effective.approvalPolicy))
      ? { approval: effective.approvalPolicy as 'untrusted' | 'on-request' | 'never' }
      : {}),
    ...(['default', 'plan'].includes(String(effective.workMode))
      ? { workMode: effective.workMode as 'default' | 'plan' }
      : {}),
    ...(typeof effective.reasoningEffort === 'string' ? { effort: effective.reasoningEffort } : {}),
    ...(typeof sandbox?.networkAccess === 'boolean' ? { networkAccess: sandbox.networkAccess } : {}),
  }
}
