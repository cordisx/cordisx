import type { ChannelNativeSessions } from './channel-native-sessions.js'

/** Profile settings are a Host service, usable even when no Channel transport is installed. */
export async function chatExecutionOperation(
  native: ChannelNativeSessions | undefined,
  operation: string,
  args: Record<string, unknown>,
) {
  const preferences = native?.executionPreferences?.()
  if (!preferences) return { status: 'unavailable', code: 'EXECUTION_SETTINGS_UNAVAILABLE' }
  const allowed = operation === 'execution-defaults' ? [] : operation === 'execution-defaults-set'
    ? ['settings', 'expectedRevision']
    : operation === 'execution-settings'
    ? ['sessionId']
    : operation === 'execution-settings-set'
    ? ['sessionId', 'settings', 'expectedRevision']
    : undefined
  if (!allowed || Object.keys(args).some(key => !allowed.includes(key))) throw new Error('INVALID_REQUEST')
  if (
    operation.endsWith('-set') && (!Number.isSafeInteger(args.expectedRevision) || Number(args.expectedRevision) < 0)
  ) throw new Error('INVALID_REQUEST')
  if (operation === 'execution-defaults') return { status: 'ok', ...await preferences.defaults() }
  if (operation === 'execution-defaults-set') {
    return { status: 'ok', ...await preferences.setDefaults(args.settings, Number(args.expectedRevision)) }
  }
  const sessionId = args.sessionId
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(sessionId)) throw new Error('INVALID_THREAD')
  if (!await native?.exists(sessionId)) throw new Error('SESSION_NOT_FOUND')
  if (operation === 'execution-settings') {
    return { status: 'ok', settings: preferences.read('local', sessionId) ?? null }
  }
  return {
    status: 'ok',
    settings: await preferences.set('local', sessionId, args.settings, Number(args.expectedRevision)),
  }
}
