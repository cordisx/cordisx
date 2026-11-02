import { expect, it, vi } from 'vitest'
import { createStartupCdpTransport } from '../packages/cli/src/launcher/startup-cdp-transport.js'
import type { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'

it('records actual loss and controls only live sessions with generation-wide sequences', async () => {
  const lost = vi.fn()
  const transport = createStartupCdpTransport({
    token: 'host',
    profileId: 'profile',
    generation: 'generation',
    onDisconnected: lost,
  })
  const session = () => {
    let closed = false
    let onClose: () => void = () => {}
    const send = vi.fn(async () => ({}))
    return {
      send,
      close() {
        closed = true
        onClose()
      },
      value: {
        send,
        isClosed: () => closed,
        onClose: (listener: () => void) => {
          onClose = listener
          return () => {}
        },
      } as unknown as CdpSession,
    }
  }
  const first = session()
  await transport.connected(first.value)
  expect(first.send.mock.calls[0]![1].expression).toContain('reconnected')
  first.close()
  expect(lost).toHaveBeenCalledOnce()
  await transport.disconnecting(first.value)
  expect(first.send).toHaveBeenCalledOnce()
  const second = session()
  await transport.connected(second.value)
  await transport.disconnecting(second.value)
  const expressions = second.send.mock.calls.map(call => call[1].expression)
  expect(expressions[0]).toContain('sequence\\":2')
  expect(expressions[1]).toContain('sequence\\":3')
  expect(expressions[1]).toContain('disconnected')
})
