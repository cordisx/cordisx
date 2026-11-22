import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import {
  dispatchNativeOwnerIdentity,
  nativeOwnerIdentity,
} from '../packages/cli/assets/launcher/native-owner-account.mjs'
import { desktopLogicalIdentity } from '../packages/cli/src/launcher/desktop-logical-identity.js'

const session = { sessionId: 'session', isActive: true, userId: 'user', selectedWorkspaceAccountId: 'workspace' }
const response = { activeSessionId: 'session', sessions: [session] }

it('derives the Desktop identity only from one consistent active account and workspace', async () => {
  const expected = 'desktop:' + createHash('sha256').update(JSON.stringify(['workspace', 'user'])).digest('hex')
  expect(nativeOwnerIdentity(response)).toBe(expected)
  expect(
    await desktopLogicalIdentity({
      current: async () => true,
      read: async () => JSON.stringify(['workspace', 'user']),
    }),
  )
    .toBe(expected)
  expect(nativeOwnerIdentity({ ...response, activeSessionId: 'other' })).toBeUndefined()
  expect(nativeOwnerIdentity({ ...response, sessions: [session, { ...session, sessionId: 'other' }] })).toBeUndefined()
  expect(nativeOwnerIdentity({ ...response, sessions: [{ ...session, selectedWorkspaceAccountId: null }] }))
    .toBeUndefined()
})

it('returns no account data when the native identity changes during readback', async () => {
  const nativeCall = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce({
    ...response,
    sessions: [{ ...session, userId: 'other' }],
  })
  const write = vi.fn(async () => {})
  expect(dispatchNativeOwnerIdentity({ type: 'native-owner-identity', id: 'id' }, {
    nativeCall,
    write,
    control: {},
    stop: () => {},
  })).toBe(true)
  await vi.waitFor(() => expect(write).toHaveBeenCalledWith({}, { id: 'id', ok: true, value: null }))
})
