import type { ScriptSourceSnapshot } from './script-types.js'

export interface ScriptComposableModel {
  readonly id: string
  readonly label: string
  readonly aliases: readonly string[]
  readonly provenance?: readonly string[]
  readonly notListed?: boolean
}

/** Membership only. The target still applies native/plugin admission and user overlays. */
export function composeScriptMembers(input: {
  readonly bindingRef: string
  readonly scopeRevision: string
  readonly authorityRevision: string
  readonly base: readonly ScriptComposableModel[]
  readonly strategy:
    | 'script-replace'
    | 'auto-augment'
    | 'native-augment'
    | 'auto-only'
    | 'native-only'
    | 'manual-replace'
  readonly script?: ScriptSourceSnapshot
}): readonly ScriptComposableModel[] {
  const { script } = input
  const valid = script?.bindingRef === input.bindingRef && script.scopeRevision === input.scopeRevision
    && script.authorityRevision === input.authorityRevision && script.complete
  if (input.strategy === 'script-replace') {
    return valid && script.mode === 'replace' ? script.models : Object.freeze([])
  }
  if (!valid || script.mode !== 'supplement' || !['auto-augment', 'native-augment'].includes(input.strategy)) {
    return input.base
  }
  const members = new Map(input.base.map(model => [model.id, model]))
  for (const model of script.models) {
    const base = members.get(model.id)
    members.set(
      model.id,
      Object.freeze({
        id: model.id,
        label: model.label,
        aliases: base?.aliases ?? Object.freeze([]),
        provenance: Object.freeze([...new Set([...(base?.provenance ?? []), 'script-supplement'])]),
        notListed: base === undefined || base.notListed === true,
      }),
    )
  }
  return Object.freeze([...members.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
