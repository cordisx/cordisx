import { useSyncExternalStore } from 'react'

interface RuntimeState {
  readonly status: 'starting' | 'active' | 'failed'
  readonly plugins: readonly PlaygroundPluginSnapshot[]
  readonly error?: string
}

let state: RuntimeState = { status: 'starting', plugins: [] }
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

function publish(next: RuntimeState): void {
  const samePlugins = next.plugins.length === state.plugins.length
    && next.plugins.every((plugin, index) => {
      const previous = state.plugins[index]
      return previous?.id === plugin.id && previous.status === plugin.status
    })
  if (next.status === state.status && next.error === state.error && samePlugins) return
  state = next
  for (const listener of listeners) listener()
}

function refresh(): void {
  const runtime = window.__cordisxRuntime
  if (runtime === undefined) return
  publish({ status: 'active', plugins: runtime.snapshot().plugins })
}

export async function bootRuntime(): Promise<void> {
  installHostBridges()
  try {
    await import('virtual:cordisx-composition')
    refresh()
  } catch (error) {
    publish({ status: 'failed', plugins: [], error: error instanceof Error ? error.message : String(error) })
  }
}

export function useRuntimeState(): RuntimeState {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener)
      if (timer === undefined) timer = setInterval(refresh, 400)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && timer !== undefined) {
          clearInterval(timer)
          timer = undefined
        }
      }
    },
    () => state,
  )
}

function installBridge(
  path: string,
  receive: (payload: string) => void,
): (payload: string) => void {
  return payload => {
    void fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }).then(response => response.text()).then(receive).catch(error => {
      const requestId = (JSON.parse(payload) as { requestId?: unknown }).requestId
      receive(JSON.stringify({ requestId, ok: false, error: String(error) }))
    })
  }
}

function installHostBridges(): void {
  window.__cordisxConfigRequestV1 = installBridge('/api/config', value => window.__cordisxConfigReceiveV1?.(value))
  window.__cordisxOwnerDocumentRequestV1 = installBridge('/api/documents', value => window.__cordisxOwnerDocumentReceiveV1?.(value))
  window.__cordisxServiceConfigRequestV1 = installBridge('/api/service-config', value => window.__cordisxServiceConfigReceiveV1?.(value))
  window.__cordisxChannelCredentialRequestV1 = installBridge('/api/channel-credential', value => window.__cordisxChannelCredentialReceiveV1?.(value))
  window.__cordisxProviderRequestV1 = installBridge('/api/provider', value => window.__cordisxProviderReceiveV1?.(value))
}
