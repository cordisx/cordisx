import { expect, it } from 'vitest'
import { ManagerLifecyclePolls } from '../packages/cli/src/cli/manager-lifecycle-polls.js'

const signal = () => new AbortController().signal
const confirmed = async () => true

it('seals a missing poll so a delayed copy cannot reach the owner', async () => {
  const polls = new ManagerLifecyclePolls()
  expect(await polls.recover(1, signal(), confirmed)).toBe(true)
  expect(polls.begin(1)).toBeUndefined()
  const next = polls.begin(2)
  expect(next).toBeDefined()
  next!.finish('empty')
  expect(await polls.recover(2, signal(), confirmed)).toBe(true)
  expect(polls.begin(1)).toBeUndefined()
  polls.close()
})

it('waits for an outstanding poll and admits only an empty result', async () => {
  const polls = new ManagerLifecyclePolls()
  const current = polls.begin(1)!
  const recovery = polls.recover(1, signal(), confirmed)
  expect(polls.begin(2)).toBeUndefined()
  current.finish('empty')
  expect(await recovery).toBe(true)
  expect(polls.begin(2)).toBeDefined()
  polls.close()
})

it('fences recovery when a command was offered or the owner cannot be confirmed', async () => {
  const offered = new ManagerLifecyclePolls()
  const current = offered.begin(1)!
  const recovery = offered.recover(1, signal(), confirmed)
  current.finish('offered')
  expect(await recovery).toBe(false)
  expect(offered.begin(2)).toBeUndefined()

  const stale = new ManagerLifecyclePolls()
  expect(await stale.recover(1, signal(), async () => false)).toBe(false)
  expect(stale.begin(2)).toBeUndefined()
})

it('holds the poll boundary until owner confirmation completes', async () => {
  const polls = new ManagerLifecyclePolls()
  let finish!: (value: boolean) => void
  const confirmation = new Promise<boolean>(resolve => finish = resolve)
  const recovery = polls.recover(1, signal(), async () => await confirmation)
  expect(polls.begin(2)).toBeUndefined()
  finish(true)
  expect(await recovery).toBe(true)
  expect(polls.begin(2)).toBeDefined()
  polls.close()
})

it('does not recover legacy polls or an unconfirmed pending poll after timeout', async () => {
  const legacy = new ManagerLifecyclePolls()
  expect(legacy.begin(undefined)).toBeDefined()
  expect(await legacy.recover(1, signal(), confirmed)).toBe(false)
  legacy.close()

  const polls = new ManagerLifecyclePolls(5)
  const pending = polls.begin(1)!
  expect(await polls.recover(1, signal(), confirmed)).toBe(false)
  pending.finish('empty')
  expect(polls.begin(2)).toBeUndefined()
})

it('does not recover after the session closes during a pending poll', async () => {
  const polls = new ManagerLifecyclePolls()
  const pending = polls.begin(1)!
  const recovery = polls.recover(1, signal(), confirmed)
  polls.close()
  pending.finish('empty')
  expect(await recovery).toBe(false)
  expect(polls.begin(2)).toBeUndefined()
})
