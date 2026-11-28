import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import type { ManagerPluginSnapshot } from '../manager.js'
import type { CordisXConfigFieldSnapshot } from '../../contracts.js'
import type { ConfigMutationOperation } from '../configuration.js'

const sensitiveRoles = new Set(['secret', 'credential', 'credential-ref', 'permission', 'capability'])

export function isSensitiveHostField(field: CordisXConfigFieldSnapshot): boolean {
  return field.role !== undefined && sensitiveRoles.has(field.role)
}

function matchingField(fields: readonly CordisXConfigFieldSnapshot[], path: readonly string[]) {
  return fields.find(field =>
    field.path.length === path.length && field.path.every((segment, index) => segment === path[index])
  )
}

/** Preserve draft values while immediately applying a newer field's restrictions. */
export function projectHostFormDraft(input: {
  readonly baseline: readonly CordisXConfigFieldSnapshot[]
  readonly latest: readonly CordisXConfigFieldSnapshot[]
  readonly committed: ReadonlyMap<string, unknown>
  readonly sameSource: boolean
}): readonly CordisXConfigFieldSnapshot[] {
  return input.baseline.map(field => {
    const key = field.path.join('.')
    const value = input.committed.has(key) ? { ...field, value: input.committed.get(key) } : field
    const current = matchingField(input.latest, field.path)
    if (!input.sameSource || !current || current.disabled) return { ...value, disabled: true }
    return isSensitiveHostField(current)
      ? { ...value, disabled: true, role: current.role!, value: undefined }
      : value
  })
}

export function canReviewHostFormDraft(
  operations: readonly ConfigMutationOperation[],
  baseline: readonly CordisXConfigFieldSnapshot[],
  latest: readonly CordisXConfigFieldSnapshot[],
): boolean {
  return operations.every(operation => {
    const previous = matchingField(baseline, operation.path)
    const field = matchingField(latest, operation.path)
    return previous !== undefined && field !== undefined && !field.disabled && !isSensitiveHostField(field)
      && previous.type === field.type && previous.role === field.role && previous.arrayItemType === field.arrayItemType
      && JSON.stringify(previous.presenter) === JSON.stringify(field.presenter)
      && JSON.stringify(previous.arrayItemSchema) === JSON.stringify(field.arrayItemSchema)
  })
}

export function groupHostFormFields(fields: readonly CordisXConfigFieldSnapshot[]) {
  const groups = new Map<string, { title?: string; description?: string; fields: CordisXConfigFieldSnapshot[] }>()
  for (const field of fields) {
    const id = field.group?.id ?? 'general'
    const current = groups.get(id) ?? {
      ...(field.group?.title === undefined ? {} : { title: field.group.title }),
      ...(field.group?.description === undefined ? {} : { description: field.group.description }),
      fields: [],
    }
    current.fields.push(field)
    groups.set(id, current)
  }
  return [...groups.entries()]
}

/** Keep the revision and fields a draft started from until the user reviews a newer snapshot. */
export function useHostFormRevision(input: {
  readonly plugin: ManagerPluginSnapshot
  readonly active: boolean
  readonly reviewBlocked: boolean
  readonly reset: () => void
}) {
  const capture = () => ({
    id: input.plugin.id,
    source: input.plugin.source,
    packageDigest: input.plugin.package?.digest,
    moduleGeneration: input.plugin.package?.moduleGeneration,
    configuration: input.plugin.configuration,
  })
  const baseline = useRef(capture())
  const reset = useRef(input.reset)
  reset.current = input.reset
  const [, render] = useState(0)
  const sameId = baseline.current.id === input.plugin.id
  const sameSource = baseline.current.source === input.plugin.source
    && baseline.current.packageDigest === input.plugin.package?.digest
    && baseline.current.moduleGeneration === input.plugin.package?.moduleGeneration
  const changed = !sameId || !sameSource
    || baseline.current.configuration.revision !== input.plugin.configuration.revision
  const stale = input.active && changed
  const canReview = stale && sameId && sameSource && !input.reviewBlocked && input.plugin.configuration.writable
    && input.plugin.configuration.revision > baseline.current.configuration.revision

  useLayoutEffect(() => {
    if (!sameId || !input.active && changed) {
      baseline.current = capture()
      reset.current()
      render(value => value + 1)
    } else if (!input.active) {
      // Refresh labels and field metadata even if the revision did not change.
      baseline.current = capture()
    }
  })

  return {
    configuration: input.active && sameId ? baseline.current.configuration : input.plugin.configuration,
    expectedRevision: input.active && sameId
      ? baseline.current.configuration.revision
      : input.plugin.configuration.revision,
    sameSource,
    stale,
    canReview,
    review() {
      if (!canReview) return false
      baseline.current = capture()
      render(value => value + 1)
      return true
    },
  }
}

/** Warn only for an independent browser Manager; never persist form values. */
export function useStandaloneDraftWarning(seat: RefObject<HTMLElement | null>, dirty: boolean): void {
  useLayoutEffect(() => {
    const view = seat.current?.closest('[data-manager-surface="standalone"]')?.ownerDocument.defaultView
    if (!dirty || !view) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    view.addEventListener('beforeunload', warn)
    return () => view.removeEventListener('beforeunload', warn)
  }, [dirty, seat])
}
