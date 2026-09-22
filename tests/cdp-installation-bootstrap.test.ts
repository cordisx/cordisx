import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createDocumentInstallationState,
  installDocumentBootstrap,
} from '../packages/cli/src/launcher/cdp-installation-bootstrap.js'
import type { CdpSession, CdpTarget } from '../packages/cli/src/launcher/cdp-session.js'

class UntouchedDocumentSession {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = []
  readonly listeners = new Map<string, (params: Record<string, unknown>) => void>()
  readonly resource = 'native resource source'

  constructor(private readonly interactBeforeReload = false) {}

  onEvent(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    this.listeners.set(method, listener)
    return () => this.listeners.delete(method)
  }

  isClosed(): boolean {
    return false
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.calls.push({ method, params })
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'production-bootstrap' }
    if (method === 'Fetch.getResponseBody') {
      return { body: Buffer.from(this.resource).toString('base64'), base64Encoded: true }
    }
    if (method !== 'Runtime.evaluate') return {}
    const expression = String(params.expression)
    if (expression.includes('document.readyState === "complete"')) return { result: { value: true } }
    if (expression === 'navigator.userActivation?.hasBeenActive !== false') return { result: { value: false } }
    if (expression.includes('queueMicrotask(() => location.reload())')) {
      if (this.interactBeforeReload) return { result: { value: false } }
      queueMicrotask(() => {
        this.listeners.get('Page.frameStartedLoading')?.({ frameId: 'native' })
        this.listeners.get('Fetch.requestPaused')?.({
          requestId: 'native-resource',
          request: { url: 'app://-/assets/native-resource.js' },
          resourceType: 'Script',
          responseStatusCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'text/javascript' }],
        })
      })
      return { result: { value: true } }
    }
    if (expression.includes('cordisx:production-boot-pending')) return { result: { value: { ok: true } } }
    return { result: { value: true } }
  }
}

describe('production document bootstrap', () => {
  it('reloads an untouched first document atomically so native providers are available in the same launch', async () => {
    const session = new UntouchedDocumentSession()
    const target = {
      id: 'native',
      type: 'page',
      title: 'Codex',
      url: 'app://-/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1/native',
    } as CdpTarget
    const state = createDocumentInstallationState()
    await installDocumentBootstrap({
      session: session as unknown as CdpSession,
      target,
      documentSource: 'future-production-source',
      evaluationSource: 'current-production-source',
      viteDevelopment: false,
      loopbackModules: true,
      nativeSubmission: {
        authority: {} as never,
        transforms: [{
          url: 'app://-/assets/native-resource.js',
          sha256: createHash('sha256').update(session.resource).digest('hex'),
          transform: source => ({
            source,
            anchorMatches: 1,
            acknowledgementExpression: 'true',
            fenceExpression: 'true',
          }),
        }],
      },
    }, state)

    expect(state.nativeInterception?.status).toBe('active')
    expect(session.calls.some(call => call.method === 'Page.reload')).toBe(false)
    expect(session.calls.some(call =>
      call.method === 'Runtime.evaluate'
      && String(call.params.expression).includes('queueMicrotask(() => location.reload())')
    )).toBe(true)
    expect(session.calls.some(call => call.params.expression === 'current-production-source')).toBe(false)

    await state.nativeInterception?.dispose()
  })

  it('preserves the current document if interaction begins while native interception is being armed', async () => {
    const session = new UntouchedDocumentSession(true)
    const target = {
      id: 'native',
      type: 'page',
      title: 'Codex',
      url: 'app://-/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1/native',
    } as CdpTarget
    const state = createDocumentInstallationState()
    await installDocumentBootstrap({
      session: session as unknown as CdpSession,
      target,
      documentSource: 'future-production-source',
      evaluationSource: 'current-production-source',
      viteDevelopment: false,
      loopbackModules: true,
      nativeSubmission: {
        authority: {} as never,
        transforms: [{
          url: 'app://-/assets/native-resource.js',
          sha256: createHash('sha256').update(session.resource).digest('hex'),
          transform: source => ({
            source,
            anchorMatches: 1,
            acknowledgementExpression: 'true',
            fenceExpression: 'true',
          }),
        }],
      },
    }, state)

    expect(state.nativeInterception?.status).toBe('installing')
    expect(session.calls.some(call => call.method === 'Page.reload')).toBe(false)
    expect(session.calls.some(call =>
      call.method === 'Runtime.evaluate'
      && String(call.params.expression).includes('globalThis.__cordisxNativeSubmissionActivate?.(false)')
      && String(call.params.expression).includes('current-production-source')
    )).toBe(true)

    await state.nativeInterception?.dispose()
  })
})
