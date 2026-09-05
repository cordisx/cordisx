import { useEffect, useState } from 'react'
import { ConfigProvider } from 'tdesign-react'
import { createRoot } from 'react-dom/client'
import type { CordisXConfigFieldSnapshot } from '../../contracts.js'
import { HostFieldRow } from './HostForm.js'

export interface HostDraftFieldDefinition {
  readonly id: string
  readonly field: CordisXConfigFieldSnapshot
  readonly initialValue: unknown
  readonly forceFullWidth?: boolean
  readonly controlId?: string
  readonly transientSecret?: boolean
  readonly onChange: (value: unknown) => void
}

export interface HostDraftFieldsMount {
  setError(id: string, message?: string): void
  clear(id: string): void
  dispose(): void
}

function DraftField({ definition, error, resetVersion, locale, onClearError }: {
  readonly definition: HostDraftFieldDefinition
  readonly error?: string
  readonly resetVersion: number
  readonly locale: string
  readonly onClearError: () => void
}) {
  const [value, setValue] = useState(definition.initialValue)
  useEffect(() => {
    setValue(definition.initialValue)
  }, [definition.initialValue, resetVersion])
  const commit = (next: unknown) => {
    setValue(next)
    definition.onChange(next)
    onClearError()
  }
  return (
    <HostFieldRow
      field={definition.field}
      value={value}
      changed={!Object.is(value, definition.initialValue)}
      locale={locale}
      idPrefix={`draft-${definition.id}`}
      {...(error === undefined ? {} : { issueText: error })}
      {...(definition.forceFullWidth === undefined ? {} : { forceFullWidth: definition.forceFullWidth })}
      {...(definition.controlId === undefined ? {} : { controlId: definition.controlId })}
      {...(definition.transientSecret === undefined ? {} : { transientSecret: definition.transientSecret })}
      onChange={commit}
      onUseDefault={() => {
        if (definition.field.hasDefault === true) commit(definition.field.defaultValue)
      }}
      onRollback={() => commit(definition.initialValue)}
      onCopyPath={() => {
        const clipboard = window.navigator.clipboard
        if (typeof clipboard?.writeText === 'function') {
          void clipboard.writeText(definition.field.path.join('.'))
            .catch(() => undefined)
        }
      }}
    />
  )
}

/** Mounts the same React field rows used by plugin configuration into a Host draft surface. */
export function mountHostDraftFields(
  container: HTMLElement,
  definitions: readonly HostDraftFieldDefinition[],
  locale: string,
): HostDraftFieldsMount {
  const root = createRoot(container)
  const errors = new Map<string, string>()
  const resets = new Map<string, number>()
  let disposed = false
  const render = () => {
    if (disposed) return
    const attach = () => container
    root.render(
      <ConfigProvider globalConfig={{ attach }}>
        <div className="cxf-form-grid">
          {definitions.map(definition => {
            const error = errors.get(definition.id)
            return (
              <DraftField
                key={definition.id}
                definition={definition}
                locale={locale}
                resetVersion={resets.get(definition.id) ?? 0}
                {...(error === undefined ? {} : { error })}
                onClearError={() => {
                  if (!errors.delete(definition.id)) return
                  render()
                }}
              />
            )
          })}
        </div>
      </ConfigProvider>,
    )
  }
  render()
  return {
    setError: (id, message) => {
      if (message === undefined || message === '') errors.delete(id)
      else errors.set(id, message)
      render()
    },
    clear: id => {
      errors.delete(id)
      resets.set(id, (resets.get(id) ?? 0) + 1)
      definitions.find(definition => definition.id === id)?.onChange('')
      render()
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      root.unmount()
    },
  }
}
