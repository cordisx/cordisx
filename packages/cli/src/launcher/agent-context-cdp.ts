import type { CdpSession } from './cdp-session.js'
import type { AgentContextBridge } from './agent-context-bridge-contract.js'

export const AGENT_CONTEXT_BINDING = '__cordisxAgentContextRequestV1'
export const AGENT_CONTEXT_RECEIVER = '__cordisxAgentContextReceiveV1'
export interface AgentContextCdpOptions {
  readonly token: string
  readonly createBridge: () => AgentContextBridge & { dispose(): void }
  readonly authorize: (sessionId: string) => boolean | Promise<boolean>
}

/** A document-scoped bridge; the owner must supply an independent session authorization. */
export async function installAgentContextCdpBinding(
  session: Pick<CdpSession, 'send' | 'onEvent' | 'onClose'>,
  input: AgentContextCdpOptions,
): Promise<() => void> {
  const documents = new Map<number, {
    bridge: AgentContextBridge & { dispose(): void }
    handles: Map<string, string>
  }>()
  let closed = false
  const retire = (contextId: number): void => {
    documents.get(contextId)?.bridge.dispose()
    documents.delete(contextId)
  }
  const clear = (): void => {
    for (const id of documents.keys()) retire(id)
  }
  await session.send('Runtime.addBinding', { name: AGENT_CONTEXT_BINDING })
  const removeRequest = session.onEvent('Runtime.bindingCalled', params => {
    if (
      params.name !== AGENT_CONTEXT_BINDING || typeof params.payload !== 'string'
      || typeof params.executionContextId !== 'number' || !Number.isSafeInteger(params.executionContextId)
    ) return
    const contextId = params.executionContextId, payload = params.payload
    void (async () => {
      let requestId = 'invalid'
      try {
        if (closed || Buffer.byteLength(payload) > 16_384) throw new Error('unavailable')
        const request = JSON.parse(payload) as Record<string, unknown>
        if (
          !request || request.version !== 1 || request.token !== input.token
          || typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 128
        ) {
          throw new Error('unavailable')
        }
        requestId = request.requestId
        let document = documents.get(contextId)
        if (!document) {
          if (documents.size >= 32) throw new Error('unavailable')
          document = { bridge: input.createBridge(), handles: new Map() }
          documents.set(contextId, document)
        }
        const { bridge } = document
        let value: unknown
        if (request.method === 'read' || request.method === 'open') {
          if (typeof request.sessionId !== 'string' || !await input.authorize(request.sessionId)) {
            throw new Error('unavailable')
          }
          if (closed || documents.get(contextId) !== document) throw new Error('unavailable')
          value = request.method === 'read'
            ? await bridge.read({ sessionId: request.sessionId })
            : await bridge.open({ sessionId: request.sessionId, thresholdRatio: request.thresholdRatio as number })
          if (
            request.method === 'open' && value && typeof value === 'object' && 'status' in value
            && value.status === 'open' && 'handle' in value && typeof value.handle === 'string'
          ) {
            document.handles.set(value.handle, request.sessionId)
          }
          if (!await input.authorize(request.sessionId)) {
            if (
              request.method === 'open' && value && typeof value === 'object' && 'handle' in value
              && typeof value.handle === 'string'
            ) {
              await bridge.close({ handle: value.handle })
              document.handles.delete(value.handle)
            }
            throw new Error('unavailable')
          }
        } else if (request.method === 'next' && typeof request.handle === 'string') {
          const owner = document.handles.get(request.handle)
          if (!owner || !await input.authorize(owner)) {
            await bridge.close({ handle: request.handle })
            document.handles.delete(request.handle)
            throw new Error('unavailable')
          }
          value = await bridge.next({ handle: request.handle, cursor: request.cursor as number })
          if (!await input.authorize(owner)) {
            await bridge.close({ handle: request.handle })
            document.handles.delete(request.handle)
            throw new Error('unavailable')
          }
          if (value && typeof value === 'object' && 'status' in value && value.status === 'closed') {
            document.handles.delete(request.handle)
          }
        } else if (request.method === 'close' && typeof request.handle === 'string') {
          await bridge.close({ handle: request.handle })
          document.handles.delete(request.handle)
          value = { status: 'closed' }
        } else throw new Error('unavailable')
        if (closed || documents.get(contextId) !== document) return
        await session.send('Runtime.evaluate', {
          expression: `void globalThis.${AGENT_CONTEXT_RECEIVER}?.(${
            JSON.stringify(JSON.stringify({ requestId, ok: true, value }))
          })`,
          contextId,
          allowUnsafeEvalBlockedByCSP: true,
        })
      } catch {
        if (closed) return
        await session.send('Runtime.evaluate', {
          expression: `void globalThis.${AGENT_CONTEXT_RECEIVER}?.(${
            JSON.stringify(JSON.stringify({ requestId, ok: false }))
          })`,
          contextId,
          allowUnsafeEvalBlockedByCSP: true,
        }).catch(() => undefined)
      }
    })()
  })
  const removeDestroyed = session.onEvent('Runtime.executionContextDestroyed', params => {
    if (typeof params.executionContextId === 'number') retire(params.executionContextId)
  })
  const removeCleared = session.onEvent('Runtime.executionContextsCleared', clear)
  let removeClosed = (): void => {}
  removeClosed = session.onClose(dispose)
  function dispose(): void {
    if (closed) return
    closed = true
    clear()
    removeRequest()
    removeDestroyed()
    removeCleared()
    removeClosed()
    void session.send('Runtime.removeBinding', { name: AGENT_CONTEXT_BINDING }).catch(() => undefined)
  }
  return dispose
}
