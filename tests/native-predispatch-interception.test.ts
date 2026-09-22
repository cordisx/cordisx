import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import {
  installNativeResourceInterception,
  type NativeResourceInterceptionSession,
  type NativeResourceTransform,
} from '../packages/cli/src/launcher/native-predispatch-interception.js'

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

class FakeSession implements NativeResourceInterceptionSession {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = []
  readonly lifecycle: string[] = []
  readonly continued: string[] = []
  readonly fulfilled: Array<Record<string, unknown>> = []
  readonly fenced: string[] = []
  readonly bodies = new Map<string, string>()
  acknowledgement = true
  failFulfillOnce = false
  failContinueOnce = false
  fenceThrows = false
  private readonly listeners = new Map<string, (params: Record<string, unknown>) => void>()

  onEvent(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    this.lifecycle.push(`listener:${method}`)
    this.listeners.set(method, listener)
    return () => {
      this.lifecycle.push(`remove-listener:${method}`)
      this.listeners.delete(method)
    }
  }

  emit(params: Record<string, unknown>, method = 'Fetch.requestPaused'): void {
    this.listeners.get(method)?.(params)
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.calls.push({ method, params })
    this.lifecycle.push(method)
    if (method === 'Fetch.getResponseBody') {
      const body = this.bodies.get(String(params.requestId))
      if (body === undefined) throw new Error('fixture body missing')
      return { body: Buffer.from(body).toString('base64'), base64Encoded: true }
    }
    if (method === 'Fetch.continueRequest') {
      if (this.failContinueOnce) {
        this.failContinueOnce = false
        throw new Error('fixture continue failed')
      }
      this.continued.push(String(params.requestId))
    }
    if (method === 'Fetch.fulfillRequest') {
      if (this.failFulfillOnce) {
        this.failFulfillOnce = false
        throw new Error('fixture fulfill failed')
      }
      this.fulfilled.push(params)
    }
    if (method === 'Runtime.evaluate') {
      const expression = String(params.expression)
      if (expression.startsWith('fence:')) {
        this.fenced.push(expression)
        return this.fenceThrows ? { exceptionDetails: { text: 'fixture fence threw' } } : { result: { value: true } }
      }
      return { result: { value: this.acknowledgement } }
    }
    return {}
  }
}

function transform(
  url: string,
  source: string,
  overrides: Partial<NativeResourceTransform> = {},
): NativeResourceTransform {
  return {
    url,
    sha256: sha256(source),
    transform: value => ({
      source: value.replace('ANCHOR', 'PATCHED'),
      anchorMatches: value.split('ANCHOR').length - 1,
      acknowledgementExpression: `ack:${url}`,
      fenceExpression: `fence:${url}`,
    }),
    ...overrides,
  }
}

function pause(session: FakeSession, requestId: string, url: string): void {
  session.emit({
    requestId,
    request: { url },
    resourceType: 'Script',
    responseStatusCode: 200,
    responseHeaders: [
      { name: 'content-length', value: '100' },
      { name: 'content-encoding', value: 'gzip' },
      { name: 'content-type', value: 'text/javascript' },
    ],
  })
}

describe('native pre-dispatch resource interception', () => {
  it('registers before Fetch enable and reload, verifies every pin, and activates only after execution acknowledgement', async () => {
    const session = new FakeSession()
    const firstUrl = 'app://-/assets/first.js'
    const secondUrl = 'app://-/assets/second.js'
    session.bodies.set('first', 'first ANCHOR source')
    session.bodies.set('second', 'second ANCHOR source')
    const statuses: string[] = []

    const installed = await installNativeResourceInterception({
      session,
      target: { id: 'native-build-8109', url: 'app://-/index.html' },
      transforms: [
        transform(firstUrl, session.bodies.get('first')!),
        transform(secondUrl, session.bodies.get('second')!),
      ],
      reloadDocument: async () => {
        session.lifecycle.push('reload')
        pause(session, 'first', firstUrl)
        pause(session, 'second', secondUrl)
      },
      onStatusChange: status => statuses.push(status),
      timeoutMs: 250,
    })

    expect(session.lifecycle.slice(0, 5)).toEqual([
      'listener:Fetch.requestPaused',
      'listener:Page.frameStartedLoading',
      'Network.setCacheDisabled',
      'Fetch.enable',
      'reload',
    ])
    expect(installed.status).toBe('active')
    expect(installed.managedRuntimeFlag).toBe(false)
    expect(installed.evidence.map(item => item.state)).toEqual(['acknowledged', 'acknowledged'])
    expect(session.fulfilled).toHaveLength(2)
    expect(session.fulfilled[0]?.responseHeaders).toEqual([
      { name: 'content-type', value: 'text/javascript' },
    ])
    expect(Buffer.from(String(session.fulfilled[0]?.body), 'base64').toString()).toContain('PATCHED')
    expect(statuses).toEqual(['active'])

    await installed.dispose()
    expect(installed.status).toBe('disposed')
    expect(statuses).toEqual(['active', 'unavailable', 'disposed'])
    expect(session.fenced).toEqual([`fence:${firstUrl}`, `fence:${secondUrl}`])
    expect(session.calls.filter(call => call.method === 'Network.setCacheDisabled').map(call => call.params))
      .toEqual([{ cacheDisabled: true }, { cacheDisabled: false }])
    expect(session.lifecycle.indexOf('remove-listener:Fetch.requestPaused')).toBeLessThan(
      session.lifecycle.indexOf('Fetch.disable'),
    )
  })

  it('arms interception without reloading an interactive document and activates on natural navigation', async () => {
    const session = new FakeSession()
    const url = 'app://-/assets/pinned.js'
    const source = 'one ANCHOR'
    session.bodies.set('natural-navigation', source)

    const installed = await installNativeResourceInterception({
      session,
      target: { id: 'native', url: 'app://-/index.html' },
      transforms: [transform(url, source)],
      timeoutMs: 100,
    })

    expect(installed.status).toBe('installing')
    expect(session.calls.some(call => call.method === 'Page.reload')).toBe(false)
    session.emit({ frameId: 'native' }, 'Page.frameStartedLoading')
    pause(session, 'natural-navigation', url)
    await vi.waitFor(() => expect(installed.status).toBe('active'))
    expect(installed.evidence[0]?.state).toBe('acknowledged')

    await installed.dispose()
  })

  it('continues the original response and reports unavailable on a pin mismatch', async () => {
    const session = new FakeSession()
    const url = 'app://-/assets/pinned.js'
    session.bodies.set('pinned', 'unexpected source')
    const transformFn = vi.fn(() => ({
      source: 'should not run',
      anchorMatches: 1,
      acknowledgementExpression: 'ack',
      fenceExpression: 'fence',
    }))

    const installed = await installNativeResourceInterception({
      session,
      target: { id: 'native', url: 'app://-/index.html' },
      transforms: [{ url, sha256: sha256('expected source'), transform: transformFn }],
      reloadDocument: async () => pause(session, 'pinned', url),
      timeoutMs: 100,
    })

    expect(installed.status).toBe('unavailable')
    expect(installed.managedRuntimeFlag).toBe(false)
    expect(installed.evidence[0]).toMatchObject({ state: 'unavailable' })
    expect(installed.evidence[0]?.reason).toContain('pin mismatch')
    expect(transformFn).not.toHaveBeenCalled()
    expect(session.continued).toEqual(['pinned'])
    expect(session.fulfilled).toEqual([])
    expect(session.calls.some(call => call.method === 'Fetch.disable')).toBe(true)
  })

  it('rejects a non-unique transform anchor and continues the original response unchanged', async () => {
    const session = new FakeSession()
    const url = 'app://-/assets/duplicate.js'
    const source = 'ANCHOR and ANCHOR'
    session.bodies.set('duplicate', source)

    const installed = await installNativeResourceInterception({
      session,
      target: { id: 'native', url: 'app://-/index.html' },
      transforms: [transform(url, source)],
      reloadDocument: async () => pause(session, 'duplicate', url),
      timeoutMs: 100,
    })

    expect(installed.status).toBe('unavailable')
    expect(installed.evidence[0]?.reason).toContain('anchor count was 2')
    expect(session.continued).toEqual(['duplicate'])
    expect(session.fulfilled).toEqual([])
  })

  it('fences a fulfilled transform and reports unavailable when execution is not acknowledged', async () => {
    const session = new FakeSession()
    session.acknowledgement = false
    const url = 'app://-/assets/unacknowledged.js'
    const source = 'one ANCHOR'
    session.bodies.set('unacknowledged', source)

    const installed = await installNativeResourceInterception({
      session,
      target: { id: 'native', url: 'app://-/index.html' },
      transforms: [transform(url, source)],
      reloadDocument: async () => pause(session, 'unacknowledged', url),
      timeoutMs: 60,
    })

    expect(session.fulfilled).toHaveLength(1)
    expect(installed.status).toBe('unavailable')
    expect(installed.evidence[0]?.reason).toContain('acknowledgement was not observed')
    expect(session.fenced).toEqual([`fence:${url}`])
    expect(session.calls.some(call => call.method === 'Fetch.disable')).toBe(true)
  })

  it('falls back to the original response after fulfill failure without losing the paused request', async () => {
    const session = new FakeSession()
    session.failFulfillOnce = true
    const url = 'app://-/assets/fulfill-failure.js'
    const source = 'one ANCHOR'
    session.bodies.set('fulfill-failure', source)

    const installed = await installNativeResourceInterception({
      session,
      target: { id: 'native', url: 'app://-/index.html' },
      transforms: [transform(url, source)],
      reloadDocument: async () => pause(session, 'fulfill-failure', url),
      timeoutMs: 100,
    })

    expect(installed.status).toBe('unavailable')
    expect(session.fulfilled).toEqual([])
    expect(session.continued).toEqual(['fulfill-failure'])
  })

  it('retains a failed continue request for a cleanup retry', async () => {
    const session = new FakeSession()
    session.failContinueOnce = true
    const url = 'app://-/assets/pin-failure.js'
    session.bodies.set('pin-failure', 'unexpected')

    const installed = await installNativeResourceInterception({
      session,
      target: { id: 'native', url: 'app://-/index.html' },
      transforms: [{ ...transform(url, 'expected ANCHOR'), sha256: sha256('expected') }],
      reloadDocument: async () => pause(session, 'pin-failure', url),
      timeoutMs: 100,
    })

    expect(installed.status).toBe('unavailable')
    expect(session.calls.filter(call => call.method === 'Fetch.continueRequest')).toHaveLength(2)
    expect(session.continued).toEqual(['pin-failure'])
  })

  it('bounds a hung document reload and disables Fetch', async () => {
    const session = new FakeSession()
    const url = 'app://-/assets/hung.js'

    const installed = await installNativeResourceInterception({
      session,
      target: { id: 'native', url: 'app://-/index.html' },
      transforms: [transform(url, 'one ANCHOR')],
      reloadDocument: async () => await new Promise<void>(() => undefined),
      timeoutMs: 30,
    })

    expect(installed.status).toBe('unavailable')
    expect(installed.evidence[0]?.reason).toContain('timed out: document reload')
    expect(session.calls.some(call => call.method === 'Fetch.disable')).toBe(true)
  })

  it('tears down an active one-document handle on abort', async () => {
    const session = new FakeSession()
    const controller = new AbortController()
    const url = 'app://-/assets/abort.js'
    const source = 'one ANCHOR'
    session.bodies.set('abort', source)
    const installed = await installNativeResourceInterception({
      session,
      target: { id: 'native', url: 'app://-/index.html' },
      transforms: [transform(url, source)],
      reloadDocument: async () => pause(session, 'abort', url),
      signal: controller.signal,
      timeoutMs: 100,
    })

    controller.abort()
    await vi.waitFor(() => expect(installed.status).toBe('unavailable'))
    expect(session.fenced).toEqual([`fence:${url}`])
    await vi.waitFor(() => expect(session.calls.some(call => call.method === 'Fetch.disable')).toBe(true))
  })

  it('revalidates and transforms pinned resources after a top-level document reload', async () => {
    const session = new FakeSession()
    const url = 'app://-/assets/second-document.js'
    const source = 'one ANCHOR'
    session.bodies.set('first-document', source)
    session.bodies.set('second-document', source)
    const statuses: string[] = []
    const installed = await installNativeResourceInterception({
      session,
      target: { id: 'native', url: 'app://-/index.html' },
      transforms: [transform(url, source)],
      reloadDocument: async () => pause(session, 'first-document', url),
      onStatusChange: status => statuses.push(status),
      timeoutMs: 100,
    })

    session.emit({ frameId: 'native' }, 'Page.frameStartedLoading')
    session.emit({ frameId: 'native' }, 'Page.frameStartedLoading')
    pause(session, 'second-document', url)
    await vi.waitFor(() => expect(statuses).toEqual(['active', 'installing', 'active']))
    expect(installed.status).toBe('active')
    expect(session.continued).not.toContain('second-document')
    expect(session.fulfilled).toHaveLength(2)
    expect(statuses).toEqual(['active', 'installing', 'active'])

    await installed.dispose()
    expect(session.fenced).toEqual([`fence:${url}`])
  })

  it('activates after required transforms and validates a lazy transform when requested', async () => {
    const session = new FakeSession()
    const requiredUrl = 'app://-/assets/required.js'
    const lazyUrl = 'app://-/assets/lazy.js'
    session.bodies.set('required', 'required ANCHOR source')
    session.bodies.set('lazy', 'lazy ANCHOR source')
    const installed = await installNativeResourceInterception({
      session,
      target: { id: 'native', url: 'app://-/index.html' },
      transforms: [
        transform(requiredUrl, session.bodies.get('required')!),
        transform(lazyUrl, session.bodies.get('lazy')!, { requiredForDocumentReady: false }),
      ],
      reloadDocument: async () => pause(session, 'required', requiredUrl),
      timeoutMs: 100,
    })

    expect(installed.status).toBe('active')
    expect(installed.evidence.find(item => item.url === lazyUrl)?.state).toBe('pending')

    pause(session, 'lazy', lazyUrl)
    await vi.waitFor(() => {
      expect(installed.evidence.find(item => item.url === lazyUrl)?.state).toBe('acknowledged')
    })
    expect(installed.status).toBe('active')
    await installed.dispose()
  })

  it('tears down without self-waiting when a reloaded document omits a required transform', async () => {
    const session = new FakeSession()
    const url = 'app://-/assets/reload-required.js'
    const source = 'one ANCHOR'
    session.bodies.set('first', source)
    const installed = await installNativeResourceInterception({
      session,
      target: { id: 'native', url: 'app://-/index.html' },
      transforms: [transform(url, source)],
      reloadDocument: async () => pause(session, 'first', url),
      timeoutMs: 60,
    })

    session.emit({ frameId: 'native' }, 'Page.frameStartedLoading')
    session.bodies.set('reload', 'unexpected source')
    pause(session, 'reload', url)
    await vi.waitFor(() => expect(installed.status).toBe('unavailable'))
    await vi.waitFor(() => expect(session.calls.some(call => call.method === 'Fetch.disable')).toBe(true))
  })

  it('surfaces a renderer fence exception during explicit disposal', async () => {
    const session = new FakeSession()
    const url = 'app://-/assets/fence-failure.js'
    const source = 'one ANCHOR'
    session.bodies.set('fence-failure', source)
    const installed = await installNativeResourceInterception({
      session,
      target: { id: 'native', url: 'app://-/index.html' },
      transforms: [transform(url, source)],
      reloadDocument: async () => pause(session, 'fence-failure', url),
      timeoutMs: 100,
    })
    session.fenceThrows = true

    await expect(installed.dispose()).rejects.toThrow('cleanup was incomplete')
    expect(installed.status).toBe('disposed')
  })

  it('never publishes active when abort lands during acknowledgement', async () => {
    const session = new FakeSession()
    const controller = new AbortController()
    const url = 'app://-/assets/abort-ack.js'
    const source = 'one ANCHOR'
    session.bodies.set('abort-ack', source)
    const originalSend = session.send.bind(session)
    session.send = async (method, params = {}) => {
      const result = await originalSend(method, params)
      if (method === 'Runtime.evaluate' && String(params.expression).startsWith('ack:')) controller.abort()
      return result
    }
    const statuses: string[] = []

    const installed = await installNativeResourceInterception({
      session,
      target: { id: 'native', url: 'app://-/index.html' },
      transforms: [transform(url, source)],
      reloadDocument: async () => pause(session, 'abort-ack', url),
      signal: controller.signal,
      onStatusChange: status => statuses.push(status),
      timeoutMs: 100,
    })

    expect(installed.status).toBe('unavailable')
    expect(statuses).not.toContain('active')
  })

  it('owns a rejected post-activation event operation and downgrades without an unhandled rejection', async () => {
    const session = new FakeSession()
    const url = 'app://-/assets/event-rejection.js'
    const source = 'one ANCHOR'
    session.bodies.set('event-rejection', source)
    const installed = await installNativeResourceInterception({
      session,
      target: { id: 'native', url: 'app://-/index.html' },
      transforms: [transform(url, source)],
      reloadDocument: async () => pause(session, 'event-rejection', url),
      timeoutMs: 100,
    })
    session.failContinueOnce = true

    pause(session, 'later-event', url)
    await vi.waitFor(() => expect(installed.status).toBe('unavailable'))
    await vi.waitFor(() => expect(session.calls.some(call => call.method === 'Fetch.disable')).toBe(true))
    expect(installed.evidence[0]?.reason).toContain('fixture continue failed')
  })
})
