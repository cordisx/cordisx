import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  CatalogManagementCode,
  CatalogManagementCommand,
  CatalogManagementRow,
  CatalogManagementView,
} from '../packages/cli/src/model-catalog-management.js'
import type {
  ScriptErrorCode,
  ScriptSourceConfig,
  ScriptSourceSnapshot,
} from '../packages/cli/src/launcher/model-catalog/script-types.js'

describe('Host-private catalog management contract', () => {
  it('uses the formal write-only script configuration with binding and management CAS', () => {
    type Configure = Extract<CatalogManagementCommand, { operation: 'configureScript' }>
    expectTypeOf<Configure['config']>().toEqualTypeOf<ScriptSourceConfig>()
    expectTypeOf<Configure['mode']>().toEqualTypeOf<'replace' | 'supplement'>()
    expectTypeOf<Configure['expectedRevision']>().toEqualTypeOf<string>()
    type ForOperation<O, C = CatalogManagementCommand> = C extends { operation: infer K } ? O extends K ? C : never
      : never
    type Run = ForOperation<'runScript' | 'cancelScript'>
    expectTypeOf<keyof Run>().toEqualTypeOf<'operation' | 'bindingRef' | 'scopeRevision' | 'expectedRevision'>()
    const command: CatalogManagementCommand = {
      operation: 'runScript',
      bindingRef: 'binding',
      scopeRevision: 'scope',
      expectedRevision: 'revision',
    }
    expect(Object.keys(command).sort()).toEqual(['bindingRef', 'expectedRevision', 'operation', 'scopeRevision'])
  })

  it('keeps script status credential-free and matches formal authority and error types', () => {
    type Status = NonNullable<CatalogManagementView['scriptState']>
    expectTypeOf<Status>().toEqualTypeOf<
      Pick<ScriptSourceSnapshot, 'authorityRevision' | 'runGeneration' | 'persistence' | 'evidence'>
    >()
    expectTypeOf<keyof Status>().toEqualTypeOf<'authorityRevision' | 'runGeneration' | 'persistence' | 'evidence'>()
    expectTypeOf<Extract<ScriptErrorCode, CatalogManagementCode>>().toEqualTypeOf<ScriptErrorCode>()
    expectTypeOf<Extract<'config' | 'command' | 'args' | 'cwd' | 'environment', keyof CatalogManagementView>>()
      .toEqualTypeOf<never>()
    expectTypeOf<Extract<'script-grant-required', CatalogManagementCode>>().toEqualTypeOf<never>()
    const status: Status = {
      authorityRevision: 'opaque-authority',
      runGeneration: 2,
      persistence: 'session-only',
      evidence: 'script-declared',
    }
    expect(status.authorityRevision).toBe('opaque-authority')
  })

  it('preserves script provenance and optional per-model Responses evidence without changing admission', () => {
    const row: CatalogManagementRow = {
      id: 'model',
      label: 'Model',
      provenance: ['auto', 'script-supplement'],
      notListed: false,
      present: true,
      selectable: false,
      blocked: true,
      pinned: false,
      protocolCapabilities: { responses: true },
    }
    expectTypeOf<CatalogManagementView['protocolCapabilities']>()
      .toEqualTypeOf<CatalogManagementRow['protocolCapabilities']>()
    expect(row.provenance).toEqual(['auto', 'script-supplement'])
    expect(row.selectable).toBe(false)
    expect(row.protocolCapabilities?.responses).toBe(true)
  })
})
