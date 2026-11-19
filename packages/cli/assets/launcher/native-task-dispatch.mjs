import { createHash } from 'node:crypto'

/** Match the native older-server first-turn representation for external providers. */
export function normalizeNativeTaskFirstTurn(params) {
  const output = params.toolOutput
  if (
    !Array.isArray(params.input) || params.input.length !== 0 || !output || typeof output !== 'object'
    || output.name !== 'create_thread' || output.namespace !== 'codex_app' || typeof output.output !== 'string'
  ) return false
  params.input = [{ type: 'text', text: output.output, text_elements: [] }]
  delete params.toolOutput
  return true
}

/** Forward native tools without exposing raw errors or task content in diagnostics. */
export function dispatchNativeTaskTool({ message, nativeCall, write, control, stop, emitDiagnostic }) {
  const tool = message.type === 'task-create' ? 'create_thread' : message.tool
  if (!['create_thread', 'list_projects', 'move_thread_to_project', 'list_threads'].includes(tool)) {
    void write(control, { id: message.id, ok: false }).catch(stop)
    return
  }
  const taskRequest = message.type === 'task-create'
  const requestRef = taskRequest && typeof message.callId === 'string'
    ? createHash('sha256').update(message.callId).digest('hex').slice(0, 20)
    : undefined
  if (taskRequest) emitDiagnostic({ event: 'model-native-task-dispatch', phase: 'native-request', requestRef })
  void nativeCall('mcpServer/tool/call', {
    server: 'codex_app',
    threadId: message.sourceThreadId,
    tool,
    arguments: message.arguments,
    _meta: {
      'openai/toolCallId': message.callId,
      'openai/threadId': message.sourceThreadId,
      'openai/turnId': message.sourceTurnId,
    },
  }).then(value => {
    if (taskRequest) emitDiagnostic({ event: 'model-native-task-dispatch', phase: 'native-response', requestRef })
    return write(control, { id: message.id, ok: true, value })
  }).catch(error => {
    const missingSource = taskRequest && error?.nativeError?.code === -32600
      && error.nativeError.message === `thread not found: ${message.sourceThreadId}`
    const reason = missingSource ? 'native-source-thread-not-loaded' : 'native-request-failed'
    if (taskRequest) emitDiagnostic({ event: 'model-native-task-dispatch', phase: 'native-error', reason, requestRef })
    return write(control, { id: message.id, ok: false, ...(taskRequest ? { reason } : {}) }).catch(stop)
  })
}
