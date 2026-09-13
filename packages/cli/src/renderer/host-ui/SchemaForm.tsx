import { HostThemeProjection } from '../host-theme.js'
import { useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react'
import { ConfigProvider } from 'tdesign-react'
import type { SchemaFormOptionsV1, SchemaFormSnapshotV1 } from '@cordisx/protocol/schema-form/v1'
import type { SchemaNode } from '../configuration/model.js'
import { fields } from '../configuration/form-presentation.js'
import { assertPath, ownValue, setAtPath } from '../configuration/values.js'
import { HOST_FORM_REACT_STYLES, HostFieldRow } from './HostForm.js'
import { hostFormValidationIssueText } from './HostFormValidation.js'
import { HostFormPageStack } from './HostFormPages.js'
import { HOST_TDESIGN_REACT_STYLES } from './tdesign-styles.js'

export function schemaFormSnapshot(
  schema: SchemaFormOptionsV1['schema'],
  value: SchemaFormOptionsV1['value'],
  locale: string,
): SchemaFormSnapshotV1 {
  if (schema.type !== 'object' || schema['~standard'].vendor !== 'schemastery') {
    return { value, valid: false, issues: [{ path: [], message: 'Only Schemastery object schemas are supported' }] }
  }
  const projected = fields(schema as SchemaNode, value, value, 'embedded', locale)
  const issues = projected.flatMap(field => {
    const message = hostFormValidationIssueText(field, field.value, locale)
    return message ? [{ path: [...field.path], message }] : []
  })
  try {
    const candidate = schema['~standard'].validate(value)
    if (candidate instanceof Promise) {
      void candidate.catch(() => undefined)
      throw new Error('Asynchronous schemas are not supported')
    }
    const result = candidate
    if (result && typeof result === 'object' && 'then' in result) {
      throw new Error('Asynchronous schemas are not supported')
    }
    if (result.issues) {
      for (const issue of result.issues) {
        issues.push({
          path: (issue.path ?? []).map(segment =>
            String(typeof segment === 'object' && segment !== null && 'key' in segment ? segment.key : segment)
          ),
          message: issue.message,
        })
      }
    }
  } catch (error) {
    issues.push({ path: [], message: error instanceof Error ? error.message : 'Schema validation failed' })
  }
  return { value, valid: issues.length === 0, issues }
}

/** Public embedded body; field projection, presenters, validation and nested editors are Host-owned. */
export function SchemaForm(
  { identity, schema, value, locale = 'en-US', disabled = false, onChange, onValidationChange }: SchemaFormOptionsV1,
) {
  const initial = useRef({ identity, value: structuredClone(value) })
  if (initial.current.identity !== identity) initial.current = { identity, value: structuredClone(value) }
  const baseline = initial.current.value
  const changeField = (path: readonly string[], next: unknown) => {
    if (disabled) return
    assertPath(path)
    const draft = setAtPath(value, path, next, false) as Record<string, unknown>
    onChange(schemaFormSnapshot(schema, draft, locale))
  }
  const id = useId()
  const container = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const theme = new HostThemeProjection(document)
    const detach = container.current ? theme.attach(container.current) : () => {}
    return () => {
      detach()
      theme.dispose()
    }
  }, [])
  const projected = useMemo(() =>
    fields(schema as SchemaNode, value, value, identity, locale).map(field => {
      let node: SchemaNode | undefined = schema as SchemaNode
      for (const segment of field.path) node = node?.dict?.[segment]
      return field.hasDefault === true ? { ...field, defaultValue: node?.meta?.default } : field
    }), [
    schema,
    value,
    baseline,
    identity,
    locale,
  ])
  const snapshot = useMemo(() => schemaFormSnapshot(schema, value, locale), [schema, value, locale])
  const validationCallback = useRef(onValidationChange)
  useLayoutEffect(() => {
    validationCallback.current = onValidationChange
  }, [onValidationChange])
  useEffect(() => {
    validationCallback.current?.(snapshot)
  }, [snapshot])
  return (
    <ConfigProvider notSet globalConfig={{ attach: () => container.current ?? document.body }}>
      <div ref={container} className="cxh-tdesign-root cxf-react-form" data-schema-form={identity}>
        <style>{HOST_TDESIGN_REACT_STYLES + HOST_FORM_REACT_STYLES}</style>
        <HostFormPageStack resetKey={identity}>
          <div className="cxf-form-body">
            <div className="cxf-form-grid">
              {projected.map(field => (
                <HostFieldRow
                  key={`${identity}/${JSON.stringify(field.path)}`}
                  field={field}
                  value={field.value}
                  locale={locale}
                  changed={JSON.stringify(field.value) !== JSON.stringify(ownValue(baseline, field.path))}
                  disabled={disabled}
                  fieldActions="menu"
                  onUseDefault={() => {
                    if (field.hasDefault === true) changeField(field.path, structuredClone(field.defaultValue))
                  }}
                  onRollback={() => changeField(field.path, structuredClone(ownValue(baseline, field.path)))}
                  onCopyPath={() => {
                    const clipboard = window.navigator.clipboard
                    if (typeof clipboard?.writeText === 'function') {
                      void clipboard.writeText(field.path.join('.')).catch(() => undefined)
                    }
                  }}
                  idPrefix={`${id}-${identity}`}
                  {...(snapshot.issues.find(issue => JSON.stringify(issue.path) === JSON.stringify(field.path))?.message
                    ? {
                      issueText:
                        snapshot.issues.find(issue => JSON.stringify(issue.path) === JSON.stringify(field.path))!
                          .message,
                    }
                    : {})}
                  onChange={next => {
                    changeField(field.path, next)
                  }}
                />
              ))}
            </div>
            {snapshot.issues.filter(issue => issue.path.length === 0).map((issue, index) => (
              <p key={index} role="alert" className="cxf-error">{issue.message}</p>
            ))}
          </div>
        </HostFormPageStack>
      </div>
    </ConfigProvider>
  )
}
