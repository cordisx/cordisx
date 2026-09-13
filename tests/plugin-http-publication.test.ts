import { expect, it, vi } from 'vitest'
import {
  guardPluginHttpPublication,
  publishPluginHttpEnvelope,
} from '../packages/cli/src/launcher/plugin-http-publication.js'
import { sendOwnerDocumentBindingResponse } from '../packages/cli/src/launcher/cdp-installation-support.js'
it('the actual CDP serializer discards private accepted data retired after authority completion', async () => {
  let trusted = true
  const result = guardPluginHttpPublication(
    { status: 'accepted', value: { secretResult: 'private-financial-result' } },
    () => {
      if (!trusted) throw new Error('trust replaced')
    },
  )
  const reply = await Promise.resolve({ requestId: 'r', ok: true, value: result })
  trusted = false
  const send = vi.fn(async () => ({}))
  await sendOwnerDocumentBindingResponse({ send } as never, reply)
  expect(send.mock.calls[0]).toEqual([
    'Runtime.evaluate',
    expect.objectContaining({ expression: expect.stringContaining('stale-generation') }),
  ])
  expect(JSON.stringify(send.mock.calls)).not.toContain('private-financial-result')
})
it('the HTTP publication envelope preserves ordinary replies and current signed results', () => {
  const ordinary = { requestId: 'r', value: { status: 'ready' } }
  expect(publishPluginHttpEnvelope(ordinary)).toBe(ordinary)
  const result = guardPluginHttpPublication({ status: 'accepted', value: { amount: 1 } }, () => {})
  const reply = { requestId: 'r', value: result }
  expect(publishPluginHttpEnvelope(reply)).toBe(reply)
  expect(JSON.stringify(reply)).toBe('{"requestId":"r","value":{"status":"accepted","value":{"amount":1}}}')
})
