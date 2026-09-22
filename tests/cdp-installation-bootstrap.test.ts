import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createDocumentInstallationState,
  installDocumentBootstrap,
} from '../packages/cli/src/launcher/cdp-installation-bootstrap.js'
import type { CdpSession, CdpTarget } from '../packages/cli/src/launcher/cdp-session.js'

class GatedDocumentSession {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = []
  readonly listeners = new Map<string, (params: Record<string, unknown>) => void>()
  readonly resource = 'native resource source'

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
    if (method === 'Page.reload') {
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
      return {}
    }
    if (method !== 'Runtime.evaluate') return {}
    const expression = String(params.expression)
    if (expression.includes('document.readyState === "complete"')) return { result: { value: true } }
    if (expression.includes('cordisx:production-boot-pending')) return { result: { value: { ok: true } } }
    return { result: { value: true } }
  }
}

describe('production document bootstrap', () => {
  it('keeps the startup gate closed until native interception and the renderer are ready', async () => {
    const session = new GatedDocumentSession()
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
    expect(session.calls.some(call => call.method === 'Page.reload')).toBe(true)
    expect(session.calls.some(call => call.params.expression === 'current-production-source')).toBe(false)

    await state.nativeInterception?.dispose()
  })
})
