import { act } from 'react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ModelCatalogClient } from '../packages/cli/src/renderer/model-catalog-client.js'
import type { ModelServicesReadResult } from '../packages/cli/src/model-service-contracts.js'
import { reactManagerFixture } from './helpers/react-manager.js'

const read: ModelServicesReadResult = {
  status: 'ok',
  revision: 'rev-1',
  services: [
    {
      id: 'sub2tok',
      displayName: 'sub2tok',
      baseUrl: 'https://api.sub2tok.com',
      apiKeyEnv: 'CORDISX_MODEL_SERVICE_SUB2TOK_KEY',
      protocols: ['anthropic-messages', 'openai-responses'],
      codexModels: ['gpt-6.1-sol'],
      claudeModels: ['claude-opus-5-5', 'claude-sonnet-5-5'],
      enabled: true,
      keyConfigured: true,
      httpHeaderNames: ['X-Private'],
      runtimeOptions: {
        codex: { supports_websockets: false, request_max_retries: 0, env_http_headers: { 'X-Token': 'SERVICE_TOKEN' } },
      },
    },
    {
      id: 'deepseek',
      displayName: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_KEY',
      protocols: ['openai-responses'],
      codexModels: ['deepseek-chat'],
      claudeModels: [],
      enabled: false,
      keyConfigured: false,
    },
  ],
}

function client(available = true) {
  const modelServicesSave = vi.fn(async () => ({
    status: 'applied' as const,
    applies: 'app-restart' as const,
    revision: 'rev-2',
  }))
  return {
    value: {
      modelServicesAvailable: available,
      modelServicesRead: vi.fn(async () => read),
      modelServicesSave,
    } as unknown as ModelCatalogClient,
    modelServicesSave,
  }
}

describe('Manager shared model services', () => {
  it('omits the empty supplemental section', async () => {
    const fixture = reactManagerFixture()
    const { value } = client()
    value.modelServicesRead = vi.fn(async () => ({ ...read, services: [] }))
    try {
      const { SharedModelServices } = await import(
        '../packages/cli/src/renderer/manager/pages/model-catalog/SharedModelServices.js'
      )
      await fixture.render(<SharedModelServices client={value} locale="zh-CN" />)
      await vi.waitFor(() => expect(value.modelServicesRead).toHaveBeenCalled())
      expect(fixture.document.querySelector('[data-shared-model-services]')).toBeNull()
    } finally {
      await fixture.dispose()
    }
  })
  it('offers the existing add form for an empty independent service list', async () => {
    const fixture = reactManagerFixture()
    const { value } = client()
    value.modelServicesRead = vi.fn(async () => ({ ...read, services: [] }))
    try {
      const { SharedModelServices } = await import(
        '../packages/cli/src/renderer/manager/pages/model-catalog/SharedModelServices.js'
      )
      await fixture.render(<SharedModelServices client={value} locale="en" showWhenEmpty />)
      const add = [...fixture.element('.cxms-shared-header').querySelectorAll('button')]
        .find(button => button.textContent === 'Add shared service')!
      await act(async () => add.click())
      expect(fixture.element('.cxmc-editor')).not.toBeNull()
    } finally {
      await fixture.dispose()
    }
  })

  it('refreshes an independent service list without replacing an open editor draft', async () => {
    const fixture = reactManagerFixture()
    const { value } = client()
    let current = read
    value.modelServicesRead = vi.fn(async () => current)
    try {
      const { SharedModelServices } = await import(
        '../packages/cli/src/renderer/manager/pages/model-catalog/SharedModelServices.js'
      )
      await fixture.render(<SharedModelServices client={value} locale="en" />)
      expect(fixture.element('[data-shared-model-service="deepseek"]')).not.toBeNull()
      vi.useFakeTimers()
      await act(async () => fixture.root.render(<SharedModelServices client={value} locale="en" reconcile />))
      current = { ...read, revision: 'rev-2', services: read.services.slice(0, 1) }
      await act(async () => await vi.advanceTimersByTimeAsync(10_000))
      expect(fixture.document.querySelector('[data-shared-model-service="deepseek"]')).toBeNull()
      const edit = fixture.element('[data-shared-model-service="sub2tok"] [aria-label^="Edit"]') as HTMLButtonElement
      await act(async () => edit.click())
      const calls = vi.mocked(value.modelServicesRead).mock.calls.length
      current = { ...read, revision: 'rev-3', services: [] }
      await act(async () => await vi.advanceTimersByTimeAsync(10_000))
      expect(vi.mocked(value.modelServicesRead)).toHaveBeenCalledTimes(calls)
      expect(fixture.element('.cxmc-editor')).not.toBeNull()
    } finally {
      vi.useRealTimers()
      await fixture.dispose()
    }
  })

  it('keeps the editor revision when an earlier refresh finishes after editing starts', async () => {
    const fixture = reactManagerFixture()
    const { value, modelServicesSave } = client()
    let finishRefresh!: (result: ModelServicesReadResult) => void
    const refresh = new Promise<ModelServicesReadResult>(resolve => {
      finishRefresh = resolve
    })
    try {
      const { SharedModelServices } = await import(
        '../packages/cli/src/renderer/manager/pages/model-catalog/SharedModelServices.js'
      )
      await fixture.render(<SharedModelServices client={value} locale="en" />)
      vi.useFakeTimers()
      value.modelServicesRead = vi.fn().mockResolvedValueOnce(read).mockReturnValueOnce(refresh).mockResolvedValue(read)
      await act(async () => fixture.root.render(<SharedModelServices client={value} locale="en" reconcile />))
      await act(async () => await vi.advanceTimersByTimeAsync(10_000))
      const edit = fixture.element('[data-shared-model-service="sub2tok"] [aria-label^="Edit"]')
      await act(async () => edit.click())
      await act(async () => finishRefresh({ ...read, revision: 'rev-2' }))
      await act(async () => fixture.element('.cxmc-editor-actions button:last-child').click())
      expect(modelServicesSave).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 'rev-1' }))
    } finally {
      vi.useRealTimers()
      await fixture.dispose()
    }
  })

  it('keeps an open draft and the uncertain-save message when readback is unavailable', async () => {
    const fixture = reactManagerFixture()
    const { value } = client()
    value.modelServicesRead = vi.fn().mockResolvedValueOnce(read)
      .mockResolvedValueOnce({ status: 'rejected', code: 'unavailable' }).mockResolvedValue(read)
    value.modelServicesSave = vi.fn(async () => ({ status: 'unknown', code: 'result-unknown' }))
    try {
      const { SharedModelServices } = await import(
        '../packages/cli/src/renderer/manager/pages/model-catalog/SharedModelServices.js'
      )
      await fixture.render(<SharedModelServices client={value} locale="en" />)
      await fixture.click('[data-shared-model-service="sub2tok"] [aria-label^="Edit"]')
      await fixture.type('.cxmc-editor [data-config-path="displayName"] input', 'My unsaved edit')
      await fixture.click('.cxmc-editor-actions button:last-child')
      expect(fixture.element('.cxmc-editor').textContent).toContain('Check the current services before retrying')
      expect((fixture.element('.cxmc-editor [data-config-path="displayName"] input') as HTMLInputElement).value)
        .toBe('My unsaved edit')
      expect((fixture.element('.cxmc-editor-actions button:last-child') as HTMLButtonElement).disabled).toBe(true)
      await fixture.click('.cxms-shared-notice button')
      expect((fixture.element('.cxmc-editor-actions button:last-child') as HTMLButtonElement).disabled).toBe(false)
      expect((fixture.element('.cxmc-editor [data-config-path="displayName"] input') as HTMLInputElement).value)
        .toBe('My unsaved edit')
    } finally {
      await fixture.dispose()
    }
  })

  it('does not replace an existing service when a new service uses its id', async () => {
    const fixture = reactManagerFixture()
    const { value, modelServicesSave } = client()
    try {
      const { SharedModelServices } = await import(
        '../packages/cli/src/renderer/manager/pages/model-catalog/SharedModelServices.js'
      )
      await fixture.render(<SharedModelServices client={value} locale="en" />)
      const add = [...fixture.element('.cxms-shared-header').querySelectorAll('button')]
        .find(button => button.textContent === 'Add shared service')!
      await act(async () => add.click())
      await fixture.type('.cxmc-editor [data-config-path="id"] input', 'sub2tok')
      await fixture.type('.cxmc-editor [data-config-path="displayName"] input', 'Duplicate')
      await fixture.type('.cxmc-editor [data-config-path="baseUrl"] input', 'https://example.test')
      await fixture.click('.cxmc-editor-actions button:last-child')
      expect(modelServicesSave).not.toHaveBeenCalled()
      expect(fixture.element('.cxmc-editor [role="status"]').textContent).toContain('Enter an ID')
    } finally {
      await fixture.dispose()
    }
  })

  it('asks the user to check the current services after an uncertain save', async () => {
    const fixture = reactManagerFixture()
    const { value } = client()
    value.modelServicesSave = vi.fn(async () => ({ status: 'unknown', code: 'result-unknown' }))
    try {
      const { SharedModelServices } = await import(
        '../packages/cli/src/renderer/manager/pages/model-catalog/SharedModelServices.js'
      )
      await fixture.render(<SharedModelServices client={value} locale="en" />)
      const remove = [...fixture.element('[data-shared-model-service="deepseek"]').querySelectorAll('button')]
        .find(button => button.textContent === 'Delete')!
      await act(async () => remove.click())
      expect(fixture.element('[role="status"]').textContent).toContain('Check the current services before retrying')
    } finally {
      await fixture.dispose()
    }
  })
  it('lists each declaration with its apps, model counts, and key state', async () => {
    const fixture = reactManagerFixture()
    try {
      const { SharedModelServices } = await import(
        '../packages/cli/src/renderer/manager/pages/model-catalog/SharedModelServices.js'
      )
      await fixture.render(<SharedModelServices client={client().value} locale="en" />)
      const rows = [...fixture.element('.cxms-shared-list').querySelectorAll('li')]
      expect(rows.map(row => row.getAttribute('data-shared-model-service'))).toEqual(['sub2tok', 'deepseek'])
      expect(rows[0]!.querySelector('.cxms-shared-tags')?.textContent).toBe('Codex · 1Claude · 2Key set')
      expect(rows[1]!.querySelector('.cxms-shared-tags')?.textContent).toBe('Codex · 1No keyDisabled')
    } finally {
      await fixture.dispose()
    }
  })

  it('deletes one declaration by saving the rest against the read revision', async () => {
    const fixture = reactManagerFixture()
    const { value, modelServicesSave } = client()
    try {
      const { SharedModelServices } = await import(
        '../packages/cli/src/renderer/manager/pages/model-catalog/SharedModelServices.js'
      )
      await fixture.render(<SharedModelServices client={value} locale="en" />)
      const remove = [...fixture.element('[data-shared-model-service="deepseek"]').querySelectorAll('button')]
        .find(button => button.textContent === 'Delete')!
      await act(async () => remove.click())
      expect(modelServicesSave).toHaveBeenCalledWith({
        expectedRevision: 'rev-1',
        services: [{
          id: 'sub2tok',
          displayName: 'sub2tok',
          baseUrl: 'https://api.sub2tok.com',
          protocols: ['anthropic-messages', 'openai-responses'],
          codexModels: ['gpt-6.1-sol'],
          claudeModels: ['claude-opus-5-5', 'claude-sonnet-5-5'],
          enabled: true,
        }],
      })
      expect(fixture.element('.cxms-shared-notice').textContent).toContain('Restart Codex or Claude')
    } finally {
      await fixture.dispose()
    }
  })

  it('opens the editor for a new service and renders nothing without a Host channel', async () => {
    const fixture = reactManagerFixture()
    try {
      const { SharedModelServices } = await import(
        '../packages/cli/src/renderer/manager/pages/model-catalog/SharedModelServices.js'
      )
      await fixture.render(<SharedModelServices client={client().value} locale="zh-CN" />)
      const add = [...fixture.element('.cxms-shared-header').querySelectorAll('button')]
        .find(button => button.textContent === '添加跨应用服务')!
      await act(async () => add.click())
      expect(fixture.element('.cxmc-editor h3').textContent).toBe('添加跨应用服务')
      await fixture.click('.cxmc-editor-actions button:first-child')

      await fixture.render(<SharedModelServices client={client(false).value} locale="en" />)
      expect(document.querySelector('[data-shared-model-services]')).toBeNull()
    } finally {
      await fixture.dispose()
    }
  })
})
