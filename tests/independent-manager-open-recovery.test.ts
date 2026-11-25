import { expect, it, vi } from 'vitest'
import { fixture } from './fixtures/standalone-manager-client.js'

it('keeps same-tab recovery when renderer opening is temporarily unavailable', async () => {
  const test = fixture({ issueResume: true, openFailure: { status: 503, body: { error: 'RENDERER_UNAVAILABLE' } } })
  try {
    expect(await test.manager.ready).toBe(false)
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/close')).toBe(true))
    const close = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/close')!
    expect(JSON.parse(String(close[1].body))).toEqual({ preserveResume: true })
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBe('f'.repeat(64))
    expect(test.unavailable).toHaveBeenCalledExactlyOnceWith('refresh')
    expect(test.importBundle).not.toHaveBeenCalled()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('does not retain startup recovery for authorization denials or malformed open errors', async () => {
  for (
    const openFailure of [
      { status: 401, body: { error: 'UNAUTHORIZED' } },
      { status: 503, body: { error: 'RENDERER_UNAVAILABLE', extra: true } },
      { status: 503, body: { error: 'OTHER' } },
    ]
  ) {
    const test = fixture({ issueResume: true, openFailure })
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
