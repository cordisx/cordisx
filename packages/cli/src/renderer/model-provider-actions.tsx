import { useEffect, useRef, useState } from 'react'
import type { ModelProviderSelectorEntryV1 } from '@cordisx/protocol/model-providers/v1'
import type { NotificationsV1 } from '../notification-contracts.js'
import { HostBrandIcon } from './host-ui/HostBrandIcon.js'

const entryIdentities = new WeakMap<ModelProviderSelectorEntryV1, number>()
let nextEntryIdentity = 0

function entryIdentity(entry: ModelProviderSelectorEntryV1): number {
  const current = entryIdentities.get(entry)
  if (current !== undefined) return current
  const identity = nextEntryIdentity++
  entryIdentities.set(entry, identity)
  return identity
}

function safeDetails(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined
  if (!message) return undefined
  const redacted = message
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/giu, '$1[redacted]')
    .replace(/((?:api[-_ ]?key|token|password|secret|credential)\s*[:=]\s*)[^\s,;]+/giu, '$1[redacted]')
    .replace(/([?&](?:api[-_]?key|token|password|secret|credential)=)[^&#\s]+/giu, '$1[redacted]')
    .replace(/(^|\s)(\/(?:[^\s/]+\/)*[^\s]+)/gu, '$1[path redacted]')
    .trim()
  return redacted.length === 0 ? undefined : redacted.slice(0, 2_000)
}

export function ProviderAction({ entry, failed, refresh, notifications }: {
  readonly entry: ModelProviderSelectorEntryV1
  readonly failed: string
  readonly refresh: () => Promise<void>
  readonly notifications?: NotificationsV1
}) {
  return (
    <ProviderActionState
      key={entryIdentity(entry)}
      entry={entry}
      failed={failed}
      refresh={refresh}
      {...(notifications === undefined ? {} : { notifications })}
    />
  )
}

function ProviderActionState({ entry, failed, refresh, notifications }: {
  readonly entry: ModelProviderSelectorEntryV1
  readonly failed: string
  readonly refresh: () => Promise<void>
  readonly notifications?: NotificationsV1
}) {
  const [busy, setBusy] = useState(false)
  const running = useRef<AbortController | null>(null)
  useEffect(() => {
    return () => {
      running.current?.abort()
      running.current = null
    }
  }, [])
  const run = async (signal: AbortSignal) => {
    await entry.action.run(signal)
    if (!signal.aborted) await refresh()
  }
  return (
    <div className="cxmp-action-entry">
      <div className="cxmp-provider-row">
        <HostBrandIcon icon={entry.icon} />
        <span>{entry.label}</span>
        <button
          type="button"
          role="menuitem"
          className="cxmp-icon-action"
          title={entry.action.label}
          aria-label={entry.action.label}
          disabled={busy}
          aria-busy={busy}
          onClick={() => {
            if (running.current !== null) return
            const controller = new AbortController()
            running.current = controller
            setBusy(true)
            void Promise.resolve().then(() => run(controller.signal)).catch(error => {
              if (controller.signal.aborted) return
              const details = safeDetails(error)
              notifications?.show({
                kind: 'model-provider.action-failed',
                type: 'error',
                message: failed,
                description: entry.label,
                ...(details === undefined ? {} : { details }),
                action: {
                  label: entry.action.label,
                  run,
                },
              })
            }).finally(() => {
              if (running.current === controller) {
                running.current = null
                if (!controller.signal.aborted) setBusy(false)
              }
            })
          }}
        >
          <HostBrandIcon icon={busy ? 'host:loader' : entry.action.icon} />
        </button>
      </div>
    </div>
  )
}
