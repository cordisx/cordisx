import { createHash } from 'node:crypto'
import { accountRouting } from './native-responses-recovery.mjs'

const text = value =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)

/** Return only the digest of an unambiguous active native account and workspace. */
export function nativeOwnerIdentity(value) {
  if (!value || typeof value !== 'object' || !text(value.activeSessionId) || !Array.isArray(value.sessions)) return
  const active = value.sessions.filter(session => session && typeof session === 'object' && session.isActive === true)
  if (active.length !== 1) return
  const session = active[0]
  if (
    session.sessionId !== value.activeSessionId || !text(session.userId) || !text(session.selectedWorkspaceAccountId)
  ) return
  return 'desktop:'
    + createHash('sha256').update(JSON.stringify([session.selectedWorkspaceAccountId, session.userId])).digest('hex')
}

/** Read only sanitized identity and routing over the launch-owned control peer. */
export function nativeAccountBridge(callPeer) {
  return {
    async nativeOwnerIdentity() {
      const value = await callPeer({ type: 'native-owner-identity' })
      return typeof value === 'string' && /^desktop:[a-f0-9]{64}$/u.test(value) ? value : undefined
    },
    async nativeRecoveryAccount() {
      return await callPeer({ type: 'native-recovery-account' })
    },
  }
}

/** Never expose native account records on the Host bridge. A changing account fails closed. */
export function dispatchNativeOwnerIdentity(message, { nativeCall, write, control, stop }) {
  if (message.type !== 'native-owner-identity' || typeof message.id !== 'string') return false
  void (async () => {
    const first = nativeOwnerIdentity(await nativeCall('accountSession/list', { refreshWorkspaceMetadata: false }))
    const second = nativeOwnerIdentity(await nativeCall('accountSession/list', { refreshWorkspaceMetadata: false }))
    return first && first === second ? first : undefined
  })().then(value => write(control, { id: message.id, ok: true, value: value ?? null }))
    .catch(() => write(control, { id: message.id, ok: false }).catch(stop))
  return true
}

/** Only opaque identity digests and the native-selected route cross this private bridge. */
export function dispatchNativeRecoveryAccount(message, { nativeCall, write, control, stop }) {
  if (message.type !== 'native-recovery-account' || typeof message.id !== 'string') return false
  void (async () => {
    const first = accountRouting(await nativeCall('account/read', { refreshToken: false }))
    const second = accountRouting(await nativeCall('account/read', { refreshToken: false }))
    return first && JSON.stringify(first) === JSON.stringify(second) ? first : undefined
  })().then(value => write(control, { id: message.id, ok: true, value: value ?? null }))
    .catch(() => write(control, { id: message.id, ok: false }).catch(stop))
  return true
}
