import { expect, it } from 'vitest'
import { entryToken, fixture } from './fixtures/standalone-manager-client.js'

it.each([false, true])('preserves an entry or recovery when an insecure origin has no worker: %s', async resume => {
  const test = fixture({
    browserOrigin: 'http://manager.example.test',
    secureContext: false,
    noServiceWorker: true,
    resume,
  })
  try {
    expect(await test.manager.ready).toBe(false)
    expect(test.unavailable).toHaveBeenCalledExactlyOnceWith('insecure-context')
    expect(test.fetch).not.toHaveBeenCalled()
    if (resume) expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBe('e'.repeat(64))
    else expect(test.win.location.hash).toBe('#' + entryToken)
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('allows an insecure origin when the browser explicitly provides the worker', async () => {
  const test = fixture({ browserOrigin: 'http://manager.example.test', secureContext: false })
  try {
    expect(await test.manager.ready).toBe(true)
    expect(test.unavailable).not.toHaveBeenCalled()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})
