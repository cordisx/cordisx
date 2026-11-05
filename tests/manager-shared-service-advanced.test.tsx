import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ModelServicesSaveRequest, ModelServiceView } from '../packages/cli/src/model-service-contracts.js'
import type { ModelCatalogClient } from '../packages/cli/src/renderer/model-catalog-client.js'
import {
  sharedServiceAdvancedDraft,
  sharedServiceAdvancedInput,
  validSharedServiceAdvanced,
} from '../packages/cli/src/renderer/manager/pages/model-catalog/SharedServiceAdvanced.js'
import { reactManagerFixture } from './helpers/react-manager.js'

const service: ModelServiceView = {
  id: 'gateway',
  displayName: 'Gateway',
  baseUrl: 'https://example.com',
  apiKeyEnv: 'PRIVATE_SERVICE_KEY_REFERENCE',
  protocols: ['openai-responses'],
  codexModels: ['gpt-6.1-sol'],
  claudeModels: [],
  enabled: true,
  keyConfigured: true,
  httpHeaderNames: ['X-Saved'],
  runtimeOptions: {
    codex: {
      supports_websockets: false,
      request_max_retries: 0,
      stream_max_retries: 3,
      stream_idle_timeout_ms: 0,
      env_http_headers: { 'X-Environment': 'SERVICE_TOKEN' },
    },
  },
}

function bridge(savedService = service) {
  const modelServicesSave = vi.fn(async (_request: ModelServicesSaveRequest) => ({
    status: 'applied' as const,
    applies: 'app-restart' as const,
    revision: 'rev-2',
  }))
  return {
    client: {
      modelServicesAvailable: true,
      modelServicesRead: async () => ({ status: 'ok', revision: 'rev-1', services: [savedService] }),
      modelServicesSave,
    } as unknown as ModelCatalogClient,
    modelServicesSave,
  }
}

async function openEditor(fixture: ReturnType<typeof reactManagerFixture>, client: ModelCatalogClient) {
  const { SharedModelServices } = await import(
    '../packages/cli/src/renderer/manager/pages/model-catalog/SharedModelServices.js'
  )
  await fixture.render(<SharedModelServices client={client} locale="en" />)
  await fixture.click('button[aria-label="Edit shared service Gateway"]')
  await fixture.click('[data-shared-service-advanced] summary')
}

const input = (name: string) => `[data-config-path="${name}"] input`

describe('Shared model service advanced settings', () => {
  it('keeps defaults distinct from false and zero, and clears only explicitly changed options', () => {
    const draft = sharedServiceAdvancedDraft(service)
    expect(draft).toMatchObject({ websockets: 'off', requestRetries: 0, streamIdleTimeout: 0 })
    expect(draft.fixedHeaders).toEqual([{ name: 'X-Saved', value: '' }])
    expect(sharedServiceAdvancedInput(draft, service)).toEqual({})

    const patch = sharedServiceAdvancedInput({ ...draft, streamRetries: undefined }, service)
    expect(patch).toEqual({
      runtimeOptions: {
        codex: {
          supports_websockets: false,
          request_max_retries: 0,
          stream_idle_timeout_ms: 0,
          env_http_headers: { 'X-Environment': 'SERVICE_TOKEN' },
        },
      },
    })
    expect(sharedServiceAdvancedInput(sharedServiceAdvancedDraft(undefined), service)).toEqual({
      runtimeOptions: { codex: {} },
      httpHeadersPatch: { 'X-Saved': null },
    })
  })

  it('uses sparse case-insensitive header edits and never substitutes a masked saved value', () => {
    const draft = sharedServiceAdvancedDraft(service)
    expect(sharedServiceAdvancedInput({ ...draft, fixedHeaders: [{ name: 'x-saved', value: '' }] }, service))
      .toEqual({})
    expect(sharedServiceAdvancedInput({
      ...draft,
      fixedHeaders: [{ name: 'x-saved', value: 'replacement' }, { name: 'X-Empty', value: '' }],
    }, service)).toEqual({ httpHeadersPatch: { 'x-saved': 'replacement', 'X-Empty': '' } })
    expect(sharedServiceAdvancedInput({
      ...draft,
      fixedHeaders: [{ name: 'X-Saved', value: '', replaceWithEmpty: true }],
    }, service)).toEqual({ httpHeadersPatch: { 'X-Saved': '' } })
    expect(sharedServiceAdvancedInput({ ...draft, fixedHeaders: [] }, service))
      .toEqual({ httpHeadersPatch: { 'X-Saved': null } })
  })

  it('rejects fractional, out-of-range and unsafe values, control characters, and duplicate headers', () => {
    const draft = sharedServiceAdvancedDraft(undefined)
    expect(validSharedServiceAdvanced(draft)).toBe(true)
    for (const value of [-1, 0.5, 4_294_967_296, NaN, Infinity]) {
      expect(validSharedServiceAdvanced({ ...draft, requestRetries: value })).toBe(false)
    }
    expect(validSharedServiceAdvanced({ ...draft, requestRetries: 0, streamIdleTimeout: Number.MAX_SAFE_INTEGER }))
      .toBe(true)
    expect(validSharedServiceAdvanced({ ...draft, streamIdleTimeout: Number.MAX_SAFE_INTEGER + 1 })).toBe(false)
    expect(validSharedServiceAdvanced({ ...draft, fixedHeaders: [{ name: 'Bad Name', value: 'value' }] })).toBe(false)
    expect(validSharedServiceAdvanced({ ...draft, fixedHeaders: [{ name: 'X-Test', value: 'a\r\nb' }] })).toBe(false)
    expect(validSharedServiceAdvanced({
      ...draft,
      fixedHeaders: [{ name: 'X-Test', value: '' }],
      environmentHeaders: [{ name: 'x-test', variable: 'TOKEN' }],
    })).toBe(false)
    expect(validSharedServiceAdvanced({ ...draft, environmentHeaders: [{ name: 'X-Test', variable: 'not a name' }] }))
      .toBe(false)
  })

  it('shows existing options through Host controls, keeps header values private, and saves a cleared retry', async () => {
    const fixture = reactManagerFixture()
    const { client, modelServicesSave } = bridge()
    try {
      await openEditor(fixture, client)
      expect(fixture.element('.cxms-shared-list').textContent).not.toContain('SERVICE_TOKEN')
      expect(fixture.document.body.textContent).not.toContain('PRIVATE_SERVICE_KEY_REFERENCE')
      expect((fixture.element(input('requestRetries')) as HTMLInputElement).value).toBe('0')
      expect((fixture.element(input('streamIdleTimeout')) as HTMLInputElement).value).toBe('0')
      expect(fixture.element('[data-config-path="websockets"]').textContent).toContain('Off')
      const summary = fixture.element('[data-config-path="fixedHeaders"] .cxf-array-row-summary')
      expect(summary.textContent).toBe('Header name: X-Saved')
      await fixture.type(input('requestRetries'), '')
      await fixture.click('.cxmc-editor .cxf-form-page-root .cxf-form-page-footer button:last-child')
      expect(modelServicesSave).toHaveBeenCalledWith({
        expectedRevision: 'rev-1',
        services: [expect.objectContaining({
          id: 'gateway',
          runtimeOptions: {
            codex: {
              supports_websockets: false,
              stream_max_retries: 3,
              stream_idle_timeout_ms: 0,
              env_http_headers: { 'X-Environment': 'SERVICE_TOKEN' },
            },
          },
        })],
      })
      expect(modelServicesSave.mock.calls[0]![0].services[0]).not.toHaveProperty('httpHeadersPatch')
    } finally {
      await fixture.dispose()
    }
  })

  it('replaces a fixed header in the Host child form without putting its value in row summaries', async () => {
    const fixture = reactManagerFixture()
    const { client, modelServicesSave } = bridge()
    try {
      await openEditor(fixture, client)
      await fixture.click('[data-config-path="fixedHeaders"] button[aria-label="Edit item"]')
      const valueSelector = '.cxf-form-page-layer:not([hidden]) [data-config-path$=".value"] input'
      expect((fixture.element(valueSelector) as HTMLInputElement).type).toBe('password')
      expect((fixture.element(valueSelector) as HTMLInputElement).value).toBe('')
      expect(fixture.element('.cxf-form-page-layer:not([hidden]) .cxf-form-subpage-body .cxf-status').textContent).toBe(
        'Configured',
      )
      expect(fixture.element('.cxf-form-page-layer:not([hidden]) [data-state="draft"]')).toBeDefined()
      const emptyToggle = '.cxf-form-page-layer:not([hidden]) button[aria-pressed]'
      expect(fixture.element(emptyToggle).getAttribute('aria-pressed')).toBe('false')
      await fixture.click(emptyToggle)
      expect(fixture.element(emptyToggle).getAttribute('aria-pressed')).toBe('true')
      await fixture.click(emptyToggle)
      await fixture.type(valueSelector, 'PRIVATE_HEADER_VALUE')
      await fixture.click('.cxf-form-page-layer:not([hidden]) .cxf-form-action-buttons button:last-child')
      expect(fixture.element('[data-config-path="fixedHeaders"] .cxf-array-row-summary').textContent)
        .not.toContain('PRIVATE_HEADER_VALUE')
      await fixture.click('.cxmc-editor .cxf-form-page-root .cxf-form-page-footer button:last-child')
      expect(modelServicesSave.mock.calls[0]![0].services[0]).toMatchObject({
        httpHeadersPatch: { 'X-Saved': 'PRIVATE_HEADER_VALUE' },
      })
      expect(modelServicesSave.mock.calls[0]![0].services[0]).not.toHaveProperty('runtimeOptions')
    } finally {
      await fixture.dispose()
    }
  })

  it('shows existing environment reference names in the editor and removes headers explicitly', async () => {
    const fixture = reactManagerFixture()
    const { client, modelServicesSave } = bridge()
    try {
      await openEditor(fixture, client)
      await fixture.click('[data-config-path="environmentHeaders"] button[aria-label="Edit item"]')
      expect(
        (fixture.element(
          '.cxf-form-page-layer:not([hidden]) [data-config-path$=".variable"] input',
        ) as HTMLInputElement).value,
      )
        .toBe('SERVICE_TOKEN')
      await fixture.click('.cxf-form-page-layer:not([hidden]) .cxf-form-action-buttons button:first-child')
      await fixture.click('[data-config-path="fixedHeaders"] button[aria-label="Delete item"]')
      await fixture.click('.cxmc-editor .cxf-form-page-root .cxf-form-page-footer button:last-child')
      expect(modelServicesSave.mock.calls[0]![0].services[0]).toMatchObject({ httpHeadersPatch: { 'X-Saved': null } })
    } finally {
      await fixture.dispose()
    }
  })

  it('takes ownership when the user explicitly resets a legacy service with blank advanced fields', async () => {
    const fixture = reactManagerFixture()
    const { runtimeOptions: _runtimeOptions, httpHeaderNames: _headerNames, ...legacy } = service
    const { client, modelServicesSave } = bridge(legacy)
    try {
      await openEditor(fixture, client)
      await fixture.click('[data-shared-service-advanced] .cxf-form-action-buttons button')
      await fixture.click('.cxmc-editor .cxf-form-page-root .cxf-form-page-footer button:last-child')
      const saved = modelServicesSave.mock.calls[0]?.[0].services[0]
      expect(saved?.runtimeOptions).toEqual({ codex: {} })
      expect(saved).not.toHaveProperty('httpHeadersPatch')
    } finally {
      await fixture.dispose()
    }
  })

  it('does not reflect rejected backend payloads into operation feedback', async () => {
    const fixture = reactManagerFixture()
    const { client, modelServicesSave } = bridge()
    modelServicesSave.mockImplementationOnce(async () =>
      ({ status: 'rejected', code: 'invalid', message: 'PRIVATE_PAYLOAD' }) as never
    )
    try {
      await openEditor(fixture, client)
      await fixture.click('.cxmc-editor .cxf-form-page-root .cxf-form-page-footer button:last-child')
      expect(fixture.document.body.textContent).not.toContain('PRIVATE_PAYLOAD')
      expect(fixture.element('.cxmc-editor').textContent).toContain('Enter an ID')
    } finally {
      await fixture.dispose()
    }
  })
})
