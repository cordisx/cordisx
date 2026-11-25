import { expect, it } from 'vitest'
import { createConsoleRetirementFixture } from './fixtures/manager-console-retirement.js'

it('waits for a late console issue to retire without disrupting another renderer', async () => {
  const f = await createConsoleRetirementFixture()
  try {
    await f.bridge.channel.prepare(f.request(f.firstToken, 'get'), f.first).dispatch()
    await f.bridge.channel.prepare(f.request(f.secondToken, 'get'), f.second).dispatch()
    const pending = f.bridge.channel.prepare(f.issue(f.firstToken, 'first'), f.first).dispatch().then(
      () => true,
      () => false,
    )
    await f.firstStarted
    expect(await f.bridge.channel.prepare(f.issue(f.secondToken, 'second'), f.second).dispatch()).toMatchObject({
      ok: true,
      value: { status: 'available', origin: f.origins[1] },
    })
    expect(f.origins[0]).not.toBe(f.origins[1])
    f.bridge.retire(f.first)
    let finished = false
    const retirement = f.bridge.waitForRetirement(f.first.rendererId).then(result => {
      finished = true
      return result
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(finished).toBe(false)
    f.release()
    expect(await retirement).toBe(true)
    expect(await pending).toBe(false)
    expect(f.disposed.has(f.origins[0]!)).toBe(true)
    expect(f.disposed.has(f.origins[1]!)).toBe(false)
    f.bridge.retire(f.second)
    expect(await f.bridge.waitForRetirement(f.second.rendererId)).toBe(true)
    expect(f.disposed.has(f.origins[1]!)).toBe(true)
  } finally {
    await f.close()
  }
})
