import { expect, it } from 'vitest'
import { entryToken, fixture } from './fixtures/standalone-manager-client.js'

it('retries a lost entry exchange once with the same tab attempt', async () => {
  const test = fixture({ issueResume: true, entryTransportFailures: 1 })
  try {
    expect(await test.manager.ready).toBe(true)
    const requests = test.fetch.mock.calls.filter(call => call[0] === '/api/session')
    expect(requests).toHaveLength(2)
    const attempts = requests.map(([, options]) => (JSON.parse(String(options.body)) as { attempt: string }).attempt)
    expect(attempts[0]).toMatch(/^[a-f0-9]{64}$/u)
    expect(new Set(attempts).size).toBe(1)
    expect(test.unavailable).not.toHaveBeenCalled()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('does not retry a denial, malformed response, or an exchange without a stable tab attempt', async () => {
  for (
    const options of [
      { entryUnauthorized: true },
      { entryMalformed: true },
      { entryTransportFailures: 1, resumeAttemptUnavailable: true },
    ]
  ) {
    const test = fixture(options)
    try {
      expect(await test.manager.ready).toBe(false)
      expect(test.fetch.mock.calls.filter(call => call[0] === '/api/session')).toHaveLength(1)
      expect(test.win.location.hash).toBe('#' + entryToken)
    } finally {
      await test.manager.close()
      test.dom.window.close()
    }
  }
})

it('cancels an entry retry when the page closes', async () => {
  const test = fixture({ entryTransportFailures: 1 })
  try {
    await Promise.resolve()
    await Promise.resolve()
    await test.manager.close()
    expect(await test.manager.ready).toBe(false)
    expect(test.fetch.mock.calls.filter(call => call[0] === '/api/session')).toHaveLength(1)
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('keeps the entry after the bounded retry also loses transport', async () => {
  const test = fixture({ entryTransportFailures: 2 })
  try {
    expect(await test.manager.ready).toBe(false)
    expect(test.fetch.mock.calls.filter(call => call[0] === '/api/session')).toHaveLength(2)
    expect(test.win.location.hash).toBe('#' + entryToken)
    expect(test.win.sessionStorage.getItem('cordisx-manager-entry-attempt')).toMatch(/^[a-f0-9]{64}$/u)
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})
