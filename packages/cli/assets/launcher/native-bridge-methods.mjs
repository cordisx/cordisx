/** Only these native methods are available to the authenticated Host bridge. */
export const BRIDGE_NATIVE_METHODS = new Set([
  'model/list',
  'thread/settings/update',
  'thread/list',
  'thread/read',
  'thread/turns/list',
  'thread/items/list',
  'thread/start',
  'thread/fork',
  'thread/resume',
  'thread/name/set',
  'thread/metadata/update',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'threadSection/list',
  'threadSection/create',
  'thread/section/move',
])

export function dispatchNativeIdle(message, { nativeCall, write, control, stop }) {
  if (message.type !== 'idle' || typeof message.id !== 'string' || typeof message.threadId !== 'string') return false
  void nativeCall('thread/read', { threadId: message.threadId, includeTurns: false }).then(result => {
    const status = result?.thread?.status?.type
    return write(control, {
      id: message.id,
      ok: true,
      value: status === 'idle' || status === 'notLoaded' || status === 'systemError',
    })
  }).catch(() => write(control, { id: message.id, ok: false }).catch(stop))
  return true
}

/** Only authenticated Host requests enter this bridge; validate their native scope again. */
export function dispatchNativeBridgeRequest(message, ports) {
  if (!['native-request', 'native-create-fenced'].includes(message.type) || typeof message.id !== 'string') return false
  const { object, logicalWriteFence, uncertainSwitches, configuredOverrides, nativeCall, write, control, stop } = ports
  const params = object(message.params)
  if (
    !BRIDGE_NATIVE_METHODS.has(message.method) || params === undefined
    || message.type === 'native-create-fenced' && !['thread/start', 'thread/fork'].includes(message.method)
    || message.type === 'native-create-fenced'
      && (!logicalWriteFence.owns(message.logicalSourceThreadId, message.logicalFenceLease)
        || message.method === 'thread/fork' && params.threadId !== message.logicalSourceThreadId)
  ) {
    void write(control, { id: message.id, ok: false }).catch(stop)
    return true
  }
  if (uncertainSwitches.has(params.threadId) && message.method === 'turn/start') {
    void write(control, { id: message.id, ok: false, reason: 'provider-switch-reconciliation-required' }).catch(stop)
    return true
  }
  if (uncertainSwitches.has(params.threadId) && ['thread/resume', 'turn/interrupt'].includes(message.method)) {
    uncertainSwitches.set(params.threadId, undefined)
  }
  const overrides = object(message.configuredProviderOverrides)
  const request = overrides ? { ...params, config: configuredOverrides(object(params.config), overrides) } : params
  void nativeCall(
    message.method,
    request,
    message.logicalFenceLease,
    message.type === 'native-create-fenced',
    message.logicalSourceThreadId,
  )
    .then(value => write(control, { id: message.id, ok: true, value }))
    .catch(error => {
      const native = error?.nativeError
      const expected = params.expectedTurnId
      const rejected = message.method === 'turn/steer' && native?.code === -32600
        && typeof native.message === 'string' && typeof expected === 'string'
        && (native.message === 'no active turn to steer'
          || native.message.startsWith(
            'expected active turn id ' + String.fromCharCode(96) + expected
              + String.fromCharCode(96) + ' but found ',
          ))
      return write(
        control,
        rejected
          ? { id: message.id, ok: true, value: { cordisxSteerRejected: true } }
          : { id: message.id, ok: false },
      ).catch(stop)
    })
  return true
}
