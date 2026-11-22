import { expect, it } from 'vitest'
import { harness } from './fixtures/native-intermediary-harness.js'

it('the authenticated intermediary preserves exact-turn acceptance and only definite native rejections', async () => {
  const h = await harness()
  try {
    h.send({ id: 'ready', method: 'echo/bytes', params: {} })
    await h.read()
    expect(
      await h.server.nativeRequest('turn/steer', {
        threadId: 'steer-fixture-accepted',
        expectedTurnId: 'turn',
        input: [],
      }),
    ).toEqual({ turnId: 'turn' })
    expect(
      await h.server.nativeRequest('turn/steer', {
        threadId: 'steer-fixture-rejected',
        expectedTurnId: 'turn',
        input: [],
      }),
    ).toEqual({ cordisxSteerRejected: true })
    await expect(
      h.server.nativeRequest('turn/steer', { threadId: 'steer-fixture-unknown', expectedTurnId: 'turn', input: [] }),
    ).rejects.toThrow()
  } finally {
    await h.close()
  }
})
