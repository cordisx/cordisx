import { useCallback, useEffect, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type {
  ManagerContentConfigCommandV1,
  ManagerContentConfigResultV1,
} from '@cordisx/protocol/manager-content-navigation/v4'
import type { ConfigMutationOperation } from './configuration.js'
import type { ManagerContentConfigBindingHandle } from './manager-content-config.js'
import type { ManagerModel, ManagerPluginSnapshot, ManagerSnapshot } from './manager.js'
import { HostForm } from './host-ui/HostForm.js'

const COMMAND_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-config-command.v1.schema.json' as const

function commandId(operation: string): string {
  return `cx-manager-config-${operation}:${crypto.randomUUID()}`
}

function resultError(result: ManagerContentConfigResultV1): Error {
  if (result.status === 'rejected' && result.validation?.state === 'invalid') {
    return new Error(result.validation.issues.map(issue => issue.message.fallback).join('; '))
  }
  return new Error(`manager content config ${result.operation} ${result.status}: ${result.code}`)
}

function ManagerContentConfigForm({ handle, locale, subscribeLocale }: {
  readonly handle: ManagerContentConfigBindingHandle
  readonly locale: () => string
  readonly subscribeLocale: (listener: () => void) => () => void
}) {
  const [configuration, setConfiguration] = useState(() => handle.snapshotForHost())
  const [error, setError] = useState<string>()
  const binding = handle.source.binding
  const refresh = useCallback(() => {
    try {
      setConfiguration(handle.snapshotForHost())
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [handle])
  const model = useMemo(() =>
    ({
      snapshot: () => ({ localization: { locale: locale() } }) as ManagerSnapshot,
      subscribe: () => () => {},
      updatePluginConfig: async (
        _pluginId: string,
        expectedRevision: number,
        operations: readonly ConfigMutationOperation[],
      ) => {
        const validate: ManagerContentConfigCommandV1 = {
          $schema: COMMAND_SCHEMA,
          contract: 'cordisx.manager-content-config-command/v1',
          schemaVersion: 1,
          commandId: commandId('validate'),
          binding,
          expectedRevision,
          operation: 'draft.validate',
          operations: operations as Extract<
            ManagerContentConfigCommandV1,
            { operation: 'draft.validate' }
          >['operations'],
        }
        const validated = await handle.source.execute(validate)
        if (validated.status !== 'validated') throw resultError(validated)
        const saved = await handle.source.execute({
          ...validate,
          commandId: commandId('save'),
          operation: 'draft.save',
          mutationId: commandId('mutation'),
        })
        if (saved.status !== 'applied' && saved.status !== 'staged') throw resultError(saved)
        refresh()
      },
    }) as unknown as ManagerModel, [binding, handle, locale])
  const plugin = useMemo(() =>
    ({
      id: handle.owner,
      source: binding.identity.source,
      name: handle.owner,
      inject: [],
      config: configuration.value,
      configuration,
      status: 'active',
    }) as ManagerPluginSnapshot, [binding.identity.source, configuration, handle.owner])

  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => Promise<unknown>) | undefined
    void (async () => {
      const initial = await handle.source.snapshot()
      if (disposed || initial.status !== 'available') {
        if (!disposed) {
          setError(initial.status === 'unavailable' ? initial.code : 'manager content config is unavailable')
        }
        return
      }
      if (handle.body.defaultMaterialization !== undefined) {
        const result = await handle.source.execute({
          $schema: COMMAND_SCHEMA,
          contract: 'cordisx.manager-content-config-command/v1',
          schemaVersion: 1,
          commandId: commandId('defaults'),
          binding,
          expectedRevision: initial.body.configuration.revision,
          operation: 'defaults.materialize',
          materializationId: `cx-manager-default:${binding.bindingId}`,
        })
        if (!disposed && !['applied', 'staged', 'preserved'].includes(result.status)) {
          setError(resultError(result).message)
        }
        if (!disposed) refresh()
      }
      const snapshot = await handle.source.snapshot()
      if (disposed || snapshot.status !== 'available') return
      const subscribed = await handle.source.subscribe(snapshot.body.sequence)
      if (subscribed.status !== 'subscribed') return
      if (disposed) {
        await subscribed.subscription.unsubscribe()
        return
      }
      unsubscribe = () => subscribed.subscription.unsubscribe()
      for await (const page of subscribed.subscription.pages) {
        if (disposed) break
        if (page.updates.some(update => update.kind === 'disposed')) {
          setError('manager content config binding was disposed')
          break
        }
        refresh()
      }
    })().catch(cause => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      disposed = true
      void unsubscribe?.()
    }
  }, [binding, handle])

  useEffect(() => subscribeLocale(refresh), [refresh, subscribeLocale])

  return (
    <div data-manager-content-config-host="true">
      {error === undefined ? null : <div className="cxr-notice cxf-alert" data-tone="error" role="alert">{error}</div>}
      <HostForm model={model} plugin={plugin} />
    </div>
  )
}

export function mountManagerContentConfigForm(
  container: HTMLElement,
  handle: ManagerContentConfigBindingHandle,
  locale: () => string,
  subscribeLocale: (listener: () => void) => () => void = () => () => {},
): () => void {
  let root: Root | undefined = createRoot(container)
  flushSync(() =>
    root?.render(<ManagerContentConfigForm handle={handle} locale={locale} subscribeLocale={subscribeLocale} />)
  )
  return () => {
    root?.unmount()
    root = undefined
  }
}
