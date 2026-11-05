import { nativeProviderFailure } from './native-provider-errors.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
const valid = (value, max = 512) =>
  typeof value === 'string' && value.length > 0 && value.length <= max
  && !/[\0\r\n]/u.test(value)
const acknowledged = (result, threadId, providerId, model) =>
  result?.thread?.id === threadId
  && result.thread.status?.type === 'idle' && result.modelProvider === providerId && result.model === model

/** A rejected provider change restores only the exact previous native session, never a Send. */
export async function switchNativeThread(message, { nativeCall, controlCall, current }) {
  const threadId = message.threadId
  const before = await nativeCall('thread/read', { threadId, includeTurns: false })
  if (message.requireIdle === true && (before?.thread?.id !== threadId || before.thread.status?.type !== 'idle')) {
    return { ok: true, value: { status: 'rejected', reason: 'thread-not-idle' } }
  }
  const prior = before?.thread
  if (prior?.ephemeral === true) return { ok: false, reason: 'provider-switch-unsupported', restored: true }
  let unsubscribeAttempted = false
  let unsubscribed = false
  try {
    if (!current()) throw new Error('Native switch cancelled')
    unsubscribeAttempted = true
    await nativeCall('thread/unsubscribe', { threadId })
    unsubscribed = true
    if (!current()) throw new Error('Native switch cancelled')
    const result = await nativeCall('thread/resume', {
      threadId,
      model: message.model,
      modelProvider: message.providerId,
      config: message.config,
      excludeTurns: true,
    })
    return current() && acknowledged(result, threadId, message.providerId, message.model)
      ? { ok: true }
      : { ok: false, reason: 'provider-switch-reconciliation-required' }
  } catch (error) {
    if (!unsubscribed) {
      return unsubscribeAttempted && !object(error.nativeError)
        ? { ok: false, reason: 'provider-switch-reconciliation-required' }
        : { ok: false }
    }
    // A timeout or uncertain acknowledgement cannot authorize another lifecycle mutation.
    if (!object(error.nativeError) || !current()) {
      return { ok: false, reason: 'provider-switch-reconciliation-required' }
    }
    const failureProvider = nativeProviderFailure({ error: error.nativeError })
    const unsupported = prior?.modelProvider !== message.providerId
      && [prior?.modelProvider, message.providerId].includes(failureProvider)
      && failureProvider !== undefined
      && (error.nativeError.data?.type === 'modelProviderMismatch'
        || failureProvider === prior?.modelProvider)
    let resumeToken
    let completed = false
    try {
      if (
        prior?.id !== threadId || !valid(prior.modelProvider, 128) || !valid(prior.model)
        || !['idle', 'notLoaded', 'systemError'].includes(prior.status?.type)
      ) throw new Error('Prior native session is unknown')
      const read = await nativeCall('thread/read', { threadId, includeTurns: false })
      if (
        !current() || read?.thread?.id !== threadId || read.thread.modelProvider !== prior.modelProvider
        || read.thread.model !== prior.model || read.thread.status?.type !== 'notLoaded'
      ) throw new Error('Native session changed during switch')
      const prepared = await controlCall('switch-resume', {
        switchId: message.id,
        threadId,
        providerId: prior.modelProvider,
        model: prior.model,
      })
      resumeToken = prepared?.resumeToken
      if (
        !current() || !['resume', 'native'].includes(prepared?.kind) || !object(prepared.configOverrides)
        || (prepared.kind === 'resume' && !valid(prepared.resumeToken, 256))
      ) throw new Error('Native restoration was not admitted')
      const restored = await nativeCall('thread/resume', {
        threadId,
        modelProvider: prior.modelProvider,
        model: prior.model,
        config: prepared.configOverrides,
        excludeTurns: true,
      })
      if (
        !current() || !acknowledged(restored, threadId, prior.modelProvider, prior.model)
      ) throw new Error('Native restoration differed')
      completed = await controlCall('switch-resume-complete', {
        switchId: message.id,
        threadId,
        providerId: prior.modelProvider,
        model: prior.model,
        ...(resumeToken === undefined ? {} : { resumeToken }),
        succeeded: true,
      }) === true
      if (!completed || !current()) throw new Error('Native restoration completion was stale')
      return { ok: false, ...(unsupported ? { reason: 'provider-switch-unsupported' } : {}), restored: true }
    } catch {
      return { ok: false, reason: 'provider-switch-reconciliation-required' }
    } finally {
      if (resumeToken !== undefined && !completed) {
        await controlCall('switch-resume-complete', {
          switchId: message.id,
          threadId,
          providerId: prior.modelProvider,
          model: prior.model,
          resumeToken,
          succeeded: false,
        }).catch(() => undefined)
      }
    }
  }
}
