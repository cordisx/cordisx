import { createHash } from 'node:crypto'
import type { StartupDiscoveredCatalogV1 } from '@cordisx/protocol/startup/v1'

export function validateStartupCatalog(value: StartupDiscoveredCatalogV1): boolean {
  if (value === null || typeof value !== 'object') return false
  if (value.state === 'pending' || value.state === 'failed') return Object.keys(value).length === 1
  if (
    value.state !== 'known' || Object.keys(value).sort().join(',') !== 'digest,generation,modelIds,state'
    || typeof value.generation !== 'string' || value.generation.length === 0
    || !Array.isArray(value.modelIds) || value.modelIds.length > 4096
    || value.modelIds.some(id => typeof id !== 'string' || id.length === 0)
    || new Set(value.modelIds).size !== value.modelIds.length
  ) return false
  const sorted = [...value.modelIds].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  return value.digest
    === `sha256:${createHash('sha256').update(JSON.stringify([value.generation, sorted])).digest('hex')}`
}
