const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const METHODS = new Set(['thread/start', 'thread/resume', 'turn/start'])
const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'])
const key = id => JSON.stringify(id)

/** Shared chat policy and exact native approvals. This module never owns model routing or account identity. */
export function createNativeChatControl({ controlCall, readNative, writeNative, emit, closed }) {
  const captures = new Map()
  const requests = new Map()
  const answered = new Map()
  const remember = request => {
    answered.set(key(request.id), request)
    if (answered.size > 256) answered.delete(answered.keys().next().value)
  }
  let sequence = 0
  const emitEvent = event => void emit(event).catch(() => undefined)
  return {
    async prepare(method, value) {
      if (!METHODS.has(method)) return { params: value }
      const params = object(value)
      const safe = {}
      for (
        const field of [
          'threadId',
          'model',
          'modelProvider',
          'serviceTier',
          'runtimeWorkspaceRoots',
          'cwd',
          'approvalPolicy',
          'sandbox',
          'sandboxPolicy',
          'effort',
          'collaborationMode',
          'permissions',
        ]
      ) {
        if (params[field] !== undefined) safe[field] = params[field]
      }
      // Forward only execution configuration; provider credentials remain in the native transport.
      const executionConfig = object(params.config)
      const config = Object.fromEntries(
        [
          'model_reasoning_effort',
          'sandbox_workspace_write.network_access',
          'service_tier',
          'sandbox_workspace_write.writable_roots',
          'sandbox_workspace_write.exclude_tmpdir_env_var',
          'sandbox_workspace_write.exclude_slash_tmp',
        ].flatMap(field => executionConfig[field] === undefined ? [] : [[field, executionConfig[field]]]),
      )
      if (Object.keys(config).length) safe.config = config
      let prepared = object(await controlCall('execution-prepare', { method, params: safe }))
      if (prepared.contextRequired && method === 'turn/start' && typeof params.threadId === 'string' && readNative) {
        const context = {}
        const result = object(await readNative('thread/read', { threadId: params.threadId, includeTurns: false }))
        const thread = object(result.thread)
        if (thread.id !== params.threadId) throw new Error('EXECUTION_CONTEXT_UNAVAILABLE')
        for (const field of ['cwd', 'model', 'reasoningEffort']) {
          if (thread[field] !== undefined) context[field] = thread[field]
        }
        prepared = object(await controlCall('execution-prepare', { method, params: safe, context }))
      }
      if (prepared.contextRequired) throw new Error('EXECUTION_CONTEXT_UNAVAILABLE')
      const fields = object(prepared.fields)
      return {
        params: {
          ...params,
          ...fields,
          ...(fields.config ? { config: { ...object(params.config), ...object(fields.config) } } : {}),
        },
        captureId: prepared.captureId,
      }
    },
    track(id, captureId) {
      if (typeof captureId === 'string') captures.set(key(id), captureId)
    },
    async complete(captureId, accepted, value) {
      if (typeof captureId !== 'string') return
      const result = object(value)
      const safe = {}
      for (
        const field of [
          'model',
          'modelProvider',
          'cwd',
          'approvalPolicy',
          'approvalsReviewer',
          'sandbox',
          'reasoningEffort',
          'activePermissionProfile',
          'serviceTier',
          'collaborationMode',
        ]
      ) {
        if (result[field] !== undefined) safe[field] = result[field]
      }
      if (object(result.thread).id) {
        const thread = object(result.thread)
        safe.thread = Object.fromEntries(
          [
            'id',
            'model',
            'modelProvider',
            'cwd',
            'approvalPolicy',
            'approvalsReviewer',
            'sandbox',
            'reasoningEffort',
            'activePermissionProfile',
            'serviceTier',
          ].flatMap(field => thread[field] === undefined ? [] : [[field, thread[field]]]),
        )
      }
      if (object(result.turn).id) safe.turn = { id: result.turn.id }
      // Native effect has already happened. A persistence failure must not turn it into a rejected send.
      try {
        await controlCall('execution-complete', { captureId, accepted, result: safe })
      } catch {
        emitEvent({ type: 'execution-persistence-failed', captureId, accepted })
      }
    },
    received(message) {
      if (message.method === undefined) {
        const captureId = captures.get(key(message.id))
        captures.delete(key(message.id))
        if (captureId) void this.complete(captureId, message.error === undefined, message.result).catch(() => undefined)
      }
      const params = object(message.params)
      if (
        [
          'thread/tokenUsage/updated',
          'turn/started',
          'turn/completed',
          'thread/compacted',
          'thread/closed',
          'thread/settings/updated',
        ].includes(message.method)
        || (['item/started', 'item/completed'].includes(message.method)
          && object(params.item).type === 'contextCompaction')
      ) {
        const turn = object(params.turn), usage = object(params.tokenUsage), last = object(usage.last)
        emitEvent({
          type: 'continuation-event',
          method: message.method,
          params: {
            threadId: params.threadId,
            ...(params.turnId === undefined ? {} : { turnId: params.turnId }),
            ...(message.method === 'turn/completed' ? { turn: { id: turn.id, status: turn.status } } : {}),
            ...(message.method === 'thread/settings/updated'
              ? {
                threadSettings: {
                  model: object(params.threadSettings).model,
                  modelProvider: object(params.threadSettings).modelProvider,
                },
              }
              : {}),
            ...(['item/started', 'item/completed'].includes(message.method)
              ? { item: { type: 'contextCompaction' } }
              : {}),
            ...(message.method === 'thread/tokenUsage/updated'
              ? {
                tokenUsage: { last: { totalTokens: last.totalTokens }, modelContextWindow: usage.modelContextWindow },
              }
              : {}),
          },
        })
      }
      if (APPROVALS.has(message.method) && message.id !== undefined && typeof params.threadId === 'string') {
        if (requests.size >= 128) return
        answered.delete(key(message.id))
        const reference = `approval-${++sequence}`
        requests.set(key(message.id), {
          reference,
          id: message.id,
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.itemId,
          method: message.method,
        })
        const preview = {}
        for (
          const field of [
            'threadId',
            'turnId',
            'itemId',
            'approvalId',
            'startedAtMs',
            'reason',
            'command',
            'cwd',
            'networkApprovalContext',
            'grantRoot',
          ]
        ) {
          if (params[field] !== undefined) preview[field] = params[field]
        }
        emitEvent({
          type: 'native-approval-event',
          event: 'requested',
          reference,
          requestId: message.id,
          method: message.method,
          params: preview,
        })
      }
      if (message.method === 'thread/settings/updated' && typeof params.threadId === 'string') {
        const settings = object(params.threadSettings), safe = {}
        for (
          const field of [
            'model',
            'modelProvider',
            'cwd',
            'approvalPolicy',
            'approvalsReviewer',
            'sandboxPolicy',
            'effort',
            'collaborationMode',
            'activePermissionProfile',
            'serviceTier',
          ]
        ) {
          if (settings[field] !== undefined) safe[field] = settings[field]
        }
        emitEvent({ type: 'execution-observed', threadId: params.threadId, settings: safe })
      }
      if (message.method === 'serverRequest/resolved' && params.requestId !== undefined) {
        const request = requests.get(key(params.requestId)) ?? answered.get(key(params.requestId))
        if (request?.threadId === params.threadId) {
          requests.delete(key(params.requestId))
          answered.delete(key(params.requestId))
          emitEvent({ type: 'native-approval-event', event: 'resolved', ...request })
        }
      }
      if (['turn/completed', 'thread/closed', 'thread/status/changed'].includes(message.method)) {
        const turnId = object(params.turn).id ?? params.turnId
        const inactive = message.method !== 'thread/status/changed' || object(params.status).type === 'idle'
        if (inactive) {
          for (const [id, request] of [...requests, ...answered]) {
            if (request.threadId !== params.threadId || turnId && request.turnId !== turnId) continue
            requests.delete(id)
            answered.delete(id)
            emitEvent({ type: 'native-approval-event', event: 'cancelled', ...request })
          }
        }
      }
    },
    desktopResponse(message) {
      if (message.method !== undefined) return false
      if (answered.has(key(message.id))) return true
      const request = requests.get(key(message.id))
      if (!request) return false
      requests.delete(key(message.id))
      remember(request)
      emitEvent({ type: 'native-approval-event', event: 'answered', ...request, source: 'desktop' })
      return false
    },
    async respond(message) {
      const request = requests.get(key(message.requestId))
      if (
        !request || closed() || request.reference !== message.reference || request.threadId !== message.threadId
        || request.turnId !== message.turnId || request.itemId !== message.itemId
      ) return { status: 'expired' }
      if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(message.decision)) return { status: 'rejected' }
      // Claim before write so desktop and external duplicates never respond twice.
      requests.delete(key(message.requestId))
      remember(request)
      try {
        await writeNative({ id: request.id, result: { decision: message.decision } })
      } catch (error) {
        emitEvent({ type: 'native-approval-event', event: 'unknown', ...request })
        throw error
      }
      emitEvent({ type: 'native-approval-event', event: 'answered', ...request, decision: message.decision })
      return { status: 'submitted' }
    },
    dispose() {
      captures.clear()
      requests.clear()
      answered.clear()
    },
  }
}
