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

      await fixture.render(<SharedModelServices client={client(false).value} locale="en" />)
      expect(document.querySelector('[data-shared-model-services]')).toBeNull()
    } finally {
      await fixture.dispose()
    }
  })
})
