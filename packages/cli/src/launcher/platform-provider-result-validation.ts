import type {
  PlatformProviderModelV1,
  PlatformProviderSessionDetailV1,
  PlatformProviderSessionV1,
} from '@cordisx/protocol/platform-provider/v1'

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields)
  const unknown = Object.keys(value).find(key => !allowed.has(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is unsupported`)
}

function string(value: unknown, label: string, maximum: number, optional = false): void {
  if (optional && value === undefined) return
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) throw new Error(`${label} is invalid`)
}

function modelRef(value: unknown, providerId: string, label: string): void {
  const ref = object(value, label)
  exact(ref, ['providerId', 'modelId'], label)
  if (ref.providerId !== providerId) throw new Error(`${label}.providerId drifted`)
  string(ref.modelId, `${label}.modelId`, 256)
}

function sessionRef(value: unknown, providerId: string, label: string): void {
  const ref = object(value, label)
  exact(ref, ['providerId', 'remoteSessionId'], label)
  if (ref.providerId !== providerId) throw new Error(`${label}.providerId drifted`)
  string(ref.remoteSessionId, `${label}.remoteSessionId`, 512)
}

function workspaceRef(value: unknown, label: string): void {
  const ref = object(value, label)
  exact(ref, ['workspaceHandle'], label)
  if (typeof ref.workspaceHandle !== 'string' || !/^ppw_[A-Za-z0-9._:-]{1,128}$/u.test(ref.workspaceHandle)) {
    throw new Error(`${label}.workspaceHandle is invalid`)
  }
}

export function assertProviderModel(value: unknown, providerId: string): asserts value is PlatformProviderModelV1 {
  const model = object(value, 'Platform provider model')
  exact(model, ['ref', 'label', 'isDefault', 'capabilities'], 'Platform provider model')
  modelRef(model.ref, providerId, 'Platform provider model.ref')
  string(model.label, 'Platform provider model.label', 200)
  if (model.isDefault !== undefined && typeof model.isDefault !== 'boolean') {
    throw new Error('Platform provider model.isDefault is invalid')
  }
  if (
    model.capabilities !== undefined && (
      !Array.isArray(model.capabilities) || model.capabilities.length > 64
      || model.capabilities.some(item => typeof item !== 'string' || item.length < 1 || item.length > 128)
    )
  ) throw new Error('Platform provider model.capabilities is invalid')
}

function assertTurn(value: unknown, label: string): void {
  const turn = object(value, label)
  exact(turn, ['turnId', 'state', 'items'], label)
  string(turn.turnId, `${label}.turnId`, 512)
  if (!['in-progress', 'completed', 'interrupted', 'failed', 'unknown'].includes(String(turn.state))) {
    throw new Error(`${label}.state is invalid`)
  }
  if (!Array.isArray(turn.items) || turn.items.length > 1_000) throw new Error(`${label}.items is invalid`)
  turn.items.forEach((candidate, index) => {
    const itemLabel = `${label}.items[${index}]`
    const item = object(candidate, itemLabel)
    exact(item, ['itemId', 'kind', 'text'], itemLabel)
    string(item.itemId, `${itemLabel}.itemId`, 512)
    if (!['user-message', 'assistant-message', 'reasoning', 'tool', 'unknown'].includes(String(item.kind))) {
      throw new Error(`${itemLabel}.kind is invalid`)
    }
    if (item.text !== undefined && (typeof item.text !== 'string' || item.text.length > 1_000_000)) {
      throw new Error(`${itemLabel}.text is invalid`)
    }
  })
}

export function assertProviderSession(
  value: unknown,
  providerId: string,
  detail = false,
): asserts value is PlatformProviderSessionV1 | PlatformProviderSessionDetailV1 {
  const session = object(value, 'Platform provider session')
  exact(
    session,
    detail
      ? ['ref', 'model', 'state', 'title', 'workspace', 'createdAt', 'updatedAt', 'turns']
      : ['ref', 'model', 'state', 'title', 'workspace', 'createdAt', 'updatedAt'],
    'Platform provider session',
  )
  sessionRef(session.ref, providerId, 'Platform provider session.ref')
  modelRef(session.model, providerId, 'Platform provider session.model')
  workspaceRef(session.workspace, 'Platform provider session.workspace')
  if (!['active', 'archived', 'deleted', 'unknown'].includes(String(session.state))) {
    throw new Error('Platform provider session.state is invalid')
  }
  if (session.title !== undefined && (typeof session.title !== 'string' || session.title.length > 1_000)) {
    throw new Error('Platform provider session.title is invalid')
  }
  for (const field of ['createdAt', 'updatedAt'] as const) {
    const timestamp = session[field]
    if (
      timestamp !== undefined && (
        typeof timestamp !== 'string' || timestamp.length > 64 || Number.isNaN(Date.parse(timestamp))
      )
    ) throw new Error(`Platform provider session.${field} is invalid`)
  }
  if (detail) {
    if (!Array.isArray(session.turns) || session.turns.length > 10_000) {
      throw new Error('Platform provider session.turns is invalid')
    }
    session.turns.forEach((turn, index) => assertTurn(turn, `Platform provider session.turns[${index}]`))
  }
}

export function assertProviderCursor(value: unknown): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== 'string' || value.length < 1 || value.length > 4_096)) {
    throw new Error('Platform provider cursor is invalid')
  }
}

export function assertProviderTurnId(value: unknown): asserts value is string {
  string(value, 'Platform provider turnId', 512)
}

export function assertProviderApprovalResult(value: unknown): asserts value is {
  readonly approvalId: string
  readonly decision: 'approved' | 'denied' | 'cancelled'
} {
  const result = object(value, 'Platform provider approval result')
  exact(result, ['approvalId', 'decision'], 'Platform provider approval result')
  string(result.approvalId, 'Platform provider approval result.approvalId', 512)
  if (!['approved', 'denied', 'cancelled'].includes(String(result.decision))) {
    throw new Error('Platform provider approval result.decision is invalid')
  }
}

const RESULT_ERROR_CODES = new Set([
  'provider-unavailable',
  'session-not-found',
  'unsupported',
  'timeout',
  'rejected',
  'adapter-failure',
  'stale-generation',
  'disposed',
])

export function assertProviderResult<Value>(
  value: unknown,
  validateValue: (value: unknown) => void,
): void {
  const result = object(value, 'Platform provider result')
  if (result.ok === true) {
    exact(result, ['ok', 'value'], 'Platform provider result')
    validateValue(result.value)
    return
  }
  if (result.ok !== false) throw new Error('Platform provider result.ok is invalid')
  exact(result, ['ok', 'error'], 'Platform provider result')
  const error = object(result.error, 'Platform provider result.error')
  exact(error, ['code', 'message', 'retryable'], 'Platform provider result.error')
  if (!RESULT_ERROR_CODES.has(String(error.code))) throw new Error('Platform provider result.error.code is invalid')
  string(error.message, 'Platform provider result.error.message', 4_096)
  if (error.retryable !== undefined && typeof error.retryable !== 'boolean') {
    throw new Error('Platform provider result.error.retryable is invalid')
  }
}

export function assertProviderModelPage(value: unknown, providerId: string): void {
  const page = object(value, 'Platform provider model page')
  exact(page, ['models', 'nextCursor'], 'Platform provider model page')
  if (!Array.isArray(page.models) || page.models.length > 1_000) throw new Error('Platform provider models are invalid')
  page.models.forEach(model => assertProviderModel(model, providerId))
  assertProviderCursor(page.nextCursor)
}

export function assertProviderSessionPage(value: unknown, providerId: string): void {
  const page = object(value, 'Platform provider session page')
  exact(page, ['sessions', 'nextCursor'], 'Platform provider session page')
  if (!Array.isArray(page.sessions) || page.sessions.length > 1_000) {
    throw new Error('Platform provider sessions are invalid')
  }
  page.sessions.forEach(session => assertProviderSession(session, providerId))
  assertProviderCursor(page.nextCursor)
}

export function assertProviderDeleted(value: unknown): void {
  const result = object(value, 'Platform provider deleted result')
  exact(result, ['deleted'], 'Platform provider deleted result')
  if (result.deleted !== true) throw new Error('Platform provider deleted result is invalid')
}

export function assertProviderTurnResult(value: unknown): void {
  const result = object(value, 'Platform provider turn result')
  exact(result, ['turnId'], 'Platform provider turn result')
  assertProviderTurnId(result.turnId)
}

export function assertProviderIntroductionResult(value: unknown): void {
  const result = object(value, 'Platform provider introduction result')
  exact(result, ['turnId', 'messageId'], 'Platform provider introduction result')
  assertProviderTurnId(result.turnId)
  string(result.messageId, 'Platform provider introduction result.messageId', 512)
}
