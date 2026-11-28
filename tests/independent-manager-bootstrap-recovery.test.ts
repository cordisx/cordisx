import { expect, it, vi } from 'vitest'
import { fixture } from './fixtures/standalone-manager-client.js'

it.each(['fetch', 'body'] as const)('keeps same-tab recovery when bootstrap %s transport fails', async failure => {
  const test = fixture({ issueResume: true, bootstrapTransportFailure: failure })
  try {
    expect(await test.manager.ready).toBe(false)
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/close')).toBe(true))
    const close = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/close')!
    expect(JSON.parse(String(close[1].body))).toEqual({ preserveResume: true })
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBe('f'.repeat(64))
    expect(test.unavailable).toHaveBeenCalledExactlyOnceWith('bootstrap-interrupted')
    expect(test.importBundle).not.toHaveBeenCalled()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('does not retain recovery for an explicit bootstrap denial or malformed reply', async () => {
  for (
    const bootstrapFailure of [
      { status: 401, body: { error: 'UNAUTHORIZED' } },
      { status: 503, body: { error: 'RENDERER_UNAVAILABLE' } },
      { status: 200, body: { status: 'ok' } },
    ]
  ) {
    const test = fixture({ issueResume: true, bootstrapFailure })
    try {
      expect(await test.manager.ready).toBe(false)
      await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/close')).toBe(true))
      const close = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/close')!
      expect(JSON.parse(String(close[1].body))).toEqual({})
      expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBeNull()
      expect(test.unavailable).toHaveBeenCalledExactlyOnceWith(undefined)
    } finally {
      await test.manager.close()
      test.dom.window.close()
    }
  }
})
