import type { StartupDeclarationV1 } from '@cordisx/protocol/startup/v1'

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('startup declaration must be an object')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== fields.length || fields.some(field => !(field in record))) {
    throw new Error('startup declaration fields are invalid')
  }
  return record
}
function id(value: unknown): void {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('startup identifier is invalid')
}
function array(value: unknown, minimum = 0): unknown[] {
  if (
    !Array.isArray(value) || value.length < minimum || value.length > 256
    || new Set(value.map(item => JSON.stringify(item))).size !== value.length
  ) throw new Error('startup list is invalid')
  return value
}
function ref(value: unknown): void {
  const item = object(value, ['pluginId', 'capabilityId'])
  id(item.pluginId)
  id(item.capabilityId)
}

/** Strict wire validation usable in Node and renderer; graph checks remain Host-owned. */
export function validateStartupDeclaration(value: unknown): StartupDeclarationV1 {
  const declaration = object(value, ['contract', 'capabilities', 'pages'])
  if (declaration.contract !== 'cordisx.startup-declaration/v1') throw new Error('startup contract is unsupported')
  for (const raw of array(declaration.capabilities)) {
    const kind = (raw as { kind?: unknown } | null)?.kind
    const item = object(raw, [
      'id',
      'serviceId',
      'dependsOn',
      'wait',
      'milestones',
      'success',
      'kind',
      ...(kind === 'provider' ? ['providerId', 'compositionOrigin'] : []),
    ])
    if (kind !== 'provider' && kind !== 'capability') throw new Error('startup capability kind is invalid')
    id(item.id)
    id(item.serviceId)
    if (kind === 'provider') {
      id(item.providerId)
      id(item.compositionOrigin)
    }
    array(item.dependsOn).forEach(ref)
    array(item.milestones).forEach(id)
    const wait = object(item.wait, ['interactive', 'command'])
    for (const policy of Object.values(wait)) {
      if (!['background', 'when-selected', 'always'].includes(String(policy))) {
        throw new Error('startup wait policy is invalid')
      }
    }
    const success = object(item.success, ['allOf'])
    for (const rawCondition of array(success.allOf, 1)) {
      const kind = (rawCondition as { kind?: unknown } | null)?.kind
      const condition = object(rawCondition, kind === 'milestone' ? ['kind', 'milestoneId'] : ['kind'])
      if (kind === 'milestone') id(condition.milestoneId)
      else if (!['service-ready', 'authenticated', 'catalog-known', 'provider-published'].includes(String(kind))) {
        throw new Error('startup condition is invalid')
      }
    }
  }
  for (const raw of array(declaration.pages)) {
    const page = object(raw, ['pageId', 'observes', 'actions'])
    id(page.pageId)
    array(page.observes).forEach(ref)
    for (const rawAction of array(page.actions)) {
      const action = object(rawAction, ['actionId', 'requires'])
      id(action.actionId)
      array(action.requires).forEach(ref)
    }
  }
  return structuredClone(value) as StartupDeclarationV1
}
