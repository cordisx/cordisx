import { createHash } from 'node:crypto'
import type {
  AdapterBundle,
  AdapterContext,
  AdapterModule,
  NativeAccountCapabilityDescriptor,
  NativeResourceTransform,
} from '@cordisx/codex-adapter'

export interface AdapterCandidate {
  readonly identity: string
  readonly bundle: AdapterBundle
}
export interface AdapterSelection {
  readonly transforms: readonly NativeResourceTransform[]
  readonly accountCapability?: NativeAccountCapabilityDescriptor
  readonly modules: readonly { id: string; identity: string; version: string }[]
  readonly rejected: readonly { id: string; identity: string; reason: string }[]
}
const digest = (source: string) => createHash('sha256').update(source).digest('hex')

/** Host checks the complete output before handing any transform to CDP. */
export function validateAdapterTransforms(
  transforms: readonly NativeResourceTransform[],
  context: AdapterContext,
): void {
  const urls = new Set<string>()
  for (const transform of transforms) {
    const resource = context.resources.find(resource => resource.url === transform.url)
    if (!resource || urls.has(transform.url) || transform.sha256 !== digest(resource.source)) {
      throw new Error('Adapter resource fingerprint missing, duplicated or changed')
    }
    urls.add(transform.url)
    if (
      transform.taskExecutionUrl && !context.resources.some(resource => resource.url === transform.taskExecutionUrl)
    ) {
      throw new Error('Adapter task execution resource missing')
    }
    const result = transform.transform(resource.source)
    if (
      result.anchorMatches !== 1 || typeof result.source !== 'string'
      || !result.acknowledgementExpression || !result.fenceExpression
    ) {
      throw new Error('Adapter transform lacks unique match, acknowledgement or fence')
    }
  }
}

/** No client maximum or cache-count limit. Ordering is policy; compatibility is structural. */
export function selectAdapterModules(
  candidates: readonly AdapterCandidate[],
  input: Omit<AdapterContext, 'transforms'>,
): AdapterSelection {
  input = { ...input, resources: Object.freeze(input.resources.map(resource => Object.freeze({ ...resource }))) }
  const rejected: Array<{ id: string; identity: string; reason: string }> = []
  const admitted = candidates.filter(candidate => {
    const b = candidate.bundle
    const valid = b?.apiVersion === 1 && b.relayContract === 1 && Array.isArray(b.modules)
      && b.modules.every(m =>
        typeof m.id === 'string' && m.id.length > 0 && typeof m.analyze === 'function'
        && Array.isArray(m.requires) && Array.isArray(m.composes)
      )
      && new Set(b.modules.map(m => m.id)).size === b.modules.length
    if (!valid) {
      rejected.push({
        id: '*',
        identity: candidate.identity,
        reason: 'Host adapter API or relay contract incompatible',
      })
    }
    return valid
  })
  type Entry = { candidate: AdapterCandidate; module: AdapterModule }
  const entries = admitted.flatMap(candidate => candidate.bundle.modules.map(module => ({ candidate, module })))
  const ids = [...new Set(['submission', ...entries.map(e => e.module.id)])]
  type State = {
    selected: Map<string, Entry>
    owners: Map<string, string>
    transforms: readonly NativeResourceTransform[]
    accountCapability?: NativeAccountCapabilityDescriptor
  }
  const empty = (): State => ({ selected: new Map(), owners: new Map(), transforms: [] })
  const add = (entry: Entry, prior: State, visiting: Set<string>): State => {
    const { module, candidate } = entry
    const present = prior.selected.get(module.id)
    if (present) {
      if (present.candidate.identity !== candidate.identity) {
        throw new Error('Dependency requires another package generation')
      }
      return prior
    }
    if (visiting.has(module.id)) throw new Error('Cyclic adapter dependency')
    let state = prior
    const nextVisiting = new Set([...visiting, module.id])
    for (const dependency of module.requires) {
      const existing = state.selected.get(dependency.id)
      if (existing && (!dependency.samePackage || existing.candidate.identity === candidate.identity)) continue
      const choices = entries.filter(e =>
        e.module.id === dependency.id
        && (!dependency.samePackage || e.candidate.identity === candidate.identity)
      )
      let found: State | undefined
      for (const choice of choices) {
        try {
          found = add(choice, state, nextVisiting)
          break
        } catch { /* Try compatible dependency. */ }
      }
      if (!found) throw new Error(`Adapter dependency unavailable: ${dependency.id}`)
      state = found
    }
    const context = Object.freeze({ ...input, transforms: state.transforms })
    const result = module.analyze(context)
    const transforms = Object.freeze(
      [...(result.transforms ?? state.transforms)].map(transform => Object.freeze(transform)),
    )
    validateAdapterTransforms(transforms, context)
    // Analyze on immutable original resources; explicit dependencies alone may replace earlier edits.
    const owners = new Map(state.owners)
    for (const transform of transforms) {
      const priorTransform = state.transforms.find(t => t.url === transform.url)
      if (priorTransform === transform) continue
      const owner = owners.get(transform.url)
      if (owner && !(module.composes.includes(owner) && module.requires.some(d => d.id === owner))) {
        throw new Error(`Adapter resource conflict: ${transform.url} (${owner}, ${module.id})`)
      }
      owners.set(transform.url, module.id)
    }
    if (state.transforms.some(t => !transforms.some(next => next.url === t.url))) {
      throw new Error('Adapter removed dependency transforms')
    }
    if (result.accountCapability) {
      const account = result.accountCapability
      if (
        !input.resources.some(r => r.url === account.module) || !account.exportName
        || (account.readerProperty !== undefined && !['accessInputs', 'accountInfo'].includes(account.readerProperty))
      ) {
        throw new Error('Adapter account capability invalid')
      }
    }
    return {
      selected: new Map([...state.selected, [module.id, entry]]),
      owners,
      transforms,
      ...(result.accountCapability ?? state.accountCapability
        ? { accountCapability: result.accountCapability ?? state.accountCapability! }
        : {}),
    }
  }
  // Backtrack the full combination: an optional module cannot pin an incompatible mandatory dependency.
  const solve = (index: number, state: State): State | undefined => {
    if (index === ids.length) return state
    const id = ids[index]!
    if (state.selected.has(id)) return solve(index + 1, state)
    for (const entry of entries.filter(e => e.module.id === id)) {
      try {
        const next = solve(index + 1, add(entry, state, new Set()))
        if (next) return next
      } catch (error) {
        rejected.push({
          id,
          identity: entry.candidate.identity,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return id === 'submission' ? undefined : solve(index + 1, state)
  }
  const state = solve(0, empty())
  if (!state || state.transforms.length === 0) {
    throw new Error(`Native submission incompatible; no compatible adapter: ${JSON.stringify(rejected)}`)
  }
  return {
    transforms: state.transforms,
    ...(state.accountCapability ? { accountCapability: state.accountCapability } : {}),
    modules: [...state.selected].map(([id, e]) => ({
      id,
      identity: e.candidate.identity,
      version: e.candidate.bundle.version,
    })),
    rejected,
  }
}
