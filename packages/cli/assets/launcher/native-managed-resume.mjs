const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
const validToken = value => typeof value === 'string' && /^[^\0\r\n]{16,256}$/u.test(value)

/** Refresh recognized persisted managed routes without changing the selected provider or inventing a Send. */
export async function prepareManagedResume(message, { nativeCall, controlCall }) {
  const params = message.params
  // Native path/history overrides can select history other than the named thread.
  if (params.path != null || params.history != null) return undefined
  const read = await nativeCall('thread/read', { threadId: params.threadId, includeTurns: false })
  const thread = read?.thread
  if (
    thread?.id !== params.threadId || !['idle', 'notLoaded', 'systemError'].includes(thread.status?.type)
    || typeof thread.modelProvider !== 'string' || thread.modelProvider === 'openai'
    || typeof thread.model !== 'string' || thread.model === ''
    || (params.modelProvider != null && params.modelProvider !== thread.modelProvider)
    || (params.config?.model_provider !== undefined && params.config.model_provider !== thread.modelProvider)
  ) return undefined
  const prepared = await controlCall('managed-resume', {
    threadId: params.threadId,
    providerId: thread.modelProvider,
    model: typeof params.model === 'string' ? params.model : thread.model,
  })
  if (prepared?.kind !== 'resume' || !validToken(prepared.resumeToken) || !object(prepared.configOverrides)) {
    return undefined
  }
  return {
    threadId: params.threadId,
    resumeToken: prepared.resumeToken,
    message: { ...message, params: { ...params, config: { ...object(params.config), ...prepared.configOverrides } } },
  }
}
