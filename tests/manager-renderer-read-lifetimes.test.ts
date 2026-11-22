import { expect, it } from 'vitest'
import { ManagerRendererReadLifetimes } from '../packages/cli/src/cli/manager-renderer-read-lifetimes.js'

it('drains Channel reads without waiting on an independent observation, but retires both', async () => {
  const lifetimes = new ManagerRendererReadLifetimes()
  const finishChannelRead = lifetimes.begin('renderer')!
  const finishObservation = lifetimes.begin('renderer', true)!
  let drained = false
  const drain = lifetimes.drainCurrent('renderer').then(result => {
    drained = result
    return result
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  finishChannelRead()
  expect(await drain).toBe(true)
  let retired = false
  const retirement = lifetimes.retire('renderer').then(() => {
    retired = true
  })
  await Promise.resolve()
  expect(retired).toBe(false)
  expect(lifetimes.begin('renderer')).toBeUndefined()
  finishObservation()
  await retirement
  expect(retired).toBe(true)
})
