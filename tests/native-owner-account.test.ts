import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import {
  dispatchNativeOwnerIdentity,
  dispatchNativeRecoveryAccount,
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

it('exposes only stable routing digests to the private recovery owner', async () => {
  const account = {
    account: { type: 'chatgpt', email: 'private@example.test' },
    userId: 'synthetic-user',
    workspaceRouting: {
      chatgptAccountId: 'synthetic-account',
      backendOrigin: 'https://regional.chatgpt.com',
      accountRoutingOverride: 'us',
    },
    accessToken: 'never-transfer',
  }
  const nativeCall = vi.fn(async () => account)
  const write = vi.fn(async () => {})
  expect(dispatchNativeRecoveryAccount({ type: 'native-recovery-account', id: 'id' }, {
    nativeCall,
    write,
    control: {},
    stop: () => {},
  })).toBe(true)
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
  const result = JSON.stringify(write.mock.calls)
  expect(result).toContain('regional.chatgpt.com')
  expect(result).not.toContain('synthetic-account')
  expect(result).not.toContain('synthetic-user')
  expect(result).not.toContain('private@example.test')
  expect(result).not.toContain('never-transfer')
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
