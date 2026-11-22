import { expect, it, vi } from 'vitest'
import { DesktopLogicalTurnAuthority } from '../packages/cli/src/launcher/desktop-logical-turn-authority.js'

const scope = {
  targetId: 'window',
  rendererGeneration: 'generation',
  navigationGeneration: 1,
  composerId: 'composer',
  threadId: 'thread',
}

it('ties an observed turn to the exact acknowledged Host submission and current account', async () => {
  const identity = vi.fn(async () => 'desktop:one')
  const authority = new DesktopLogicalTurnAuthority(identity)
  const token = (await authority.issue(scope))!
  expect(await authority.begin(token, 'thread', 'request')).toBe(true)
  expect(await authority.authorize(token, 'other')).toBe(false)
  expect(await authority.authorize(token, 'request')).toBe(true)
  authority.observe('turn/started', { threadId: 'thread', turn: { id: 'turn' } })
  const pending = authority.activeIdentity('thread', 'turn')
  expect(authority.confirm(token, 'thread', 'turn', 'request')).toBe(true)
  expect(await pending).toBe('desktop:one')
  identity.mockResolvedValue('desktop:other')
  expect(await authority.activeIdentity('thread', 'turn')).toBeUndefined()
  authority.observe('turn/completed', { threadId: 'thread', turn: { id: 'turn' } })
  identity.mockResolvedValue('desktop:one')
  expect(await authority.activeIdentity('thread', 'turn')).toBeUndefined()
})

it('rejects competing starts, mismatched turns and cross-thread ticket use', async () => {
  const authority = new DesktopLogicalTurnAuthority(async () => 'desktop:one')
  const first = (await authority.issue(scope))!, second = (await authority.issue(scope))!
  expect(await authority.begin(first, 'other', 'request')).toBe(false)
  expect(await authority.begin(first, 'thread', 'request')).toBe(true)
  expect(await authority.begin(second, 'thread', 'other-request')).toBe(false)
  authority.observe('turn/started', { threadId: 'thread', turn: { id: 'other-turn' } })
  expect(authority.confirm(first, 'thread', 'turn', 'request')).toBe(false)
  expect(await authority.activeIdentity('thread', 'other-turn')).toBeUndefined()
})

it('withholds identity if the turn finishes while the account read is in flight', async () => {
  let finish!: (value: string) => void
  const identity = vi.fn(async () => 'desktop:one')
  const authority = new DesktopLogicalTurnAuthority(identity)
  const token = (await authority.issue(scope))!
  expect(await authority.begin(token, 'thread', 'request')).toBe(true)
  expect(authority.confirm(token, 'thread', 'turn', 'request')).toBe(true)
  authority.observe('turn/started', { threadId: 'thread', turn: { id: 'turn' } })
  identity.mockImplementationOnce(() =>
    new Promise(resolve => {
      finish = resolve
    })
  )
  const result = authority.activeIdentity('thread', 'turn')
  authority.observe('turn/completed', { threadId: 'thread', turn: { id: 'turn' } })
  finish('desktop:one')
  expect(await result).toBeUndefined()
})
