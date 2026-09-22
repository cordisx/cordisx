import {
  boundedString,
  CatalogError,
  type CatalogModel,
  type CatalogStrategy,
  type CatalogSupplement,
  object,
} from './contracts.js'

export function parseSupplement(value: unknown): CatalogSupplement {
  const input = object(value)
  if (
    !input || !boundedString(input.scopeRevision) || !boundedString(input.authorityRevision)
    || !Array.isArray(input.models) || input.models.length > 10_000
    || Object.keys(input).some(key => !['scopeRevision', 'authorityRevision', 'models'].includes(key))
  ) {
    throw new CatalogError('source-invalid')
  }
  const seen = new Set<string>()
  const models = input.models.flatMap(value => {
    const model = object(value)
    if (
      !model || !boundedString(model.id) || (model.label !== undefined && !boundedString(model.label, 256))
      || Object.keys(model).some(key => key !== 'id' && key !== 'label')
    ) throw new CatalogError('source-invalid')
    if (seen.has(model.id)) return []
    seen.add(model.id)
    return [Object.freeze({ id: model.id, ...(typeof model.label === 'string' ? { label: model.label } : {}) })]
  })
  return Object.freeze({
    scopeRevision: input.scopeRevision,
    authorityRevision: input.authorityRevision,
    models: Object.freeze(models),
  })
}

export function composeMembers(
  source: readonly CatalogModel[],
  strategy: CatalogStrategy,
  supplement?: CatalogSupplement,
): readonly CatalogModel[] {
  const provenance = strategy.kind === 'auto' ? 'auto' : strategy.kind === 'native' ? 'native' : 'manual'
  const members = new Map(
    source.map(
      model => [model.id, Object.freeze({ ...model, provenance: Object.freeze([provenance]) }) as CatalogModel],
    ),
  )
  if ((strategy.kind === 'auto' || strategy.kind === 'native') && strategy.mode === 'augment') {
    for (const model of supplement?.models ?? []) {
      const existing = members.get(model.id)
      members.set(
        model.id,
        Object.freeze({
          id: model.id,
          label: model.label ?? existing?.label ?? model.id,
          aliases: existing?.aliases ?? Object.freeze([]),
          provenance: Object.freeze(existing ? [provenance, 'manual-supplement'] : ['manual-supplement']),
          notListed: existing === undefined,
        }) as CatalogModel,
      )
    }
  }
  return Object.freeze([...members.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
