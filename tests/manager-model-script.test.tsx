import React, { act } from 'react'
import { describe, expect, it } from 'vitest'
import type { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import { catalogFixture, catalogView } from './helpers/catalog-management-fixture.js'
import { reactManagerFixture } from './helpers/react-manager.js'

async function configure(fixture: ReturnType<typeof reactManagerFixture>) {
  await fixture.click('[aria-label="More catalog actions: Provider A"]')
  const item = [...fixture.document.querySelectorAll<HTMLElement>('.t-dropdown__item')]
    .find(item => item.textContent === 'Configure model script')
  expect(item).toBeDefined()
  await act(async () => item!.click())
}

describe('model script Manager configuration', () => {
  it('keeps script controls independent from automatic discovery activity', async () => {
    const fixture = reactManagerFixture()
    const host = catalogFixture()
    const { CatalogBinding } = await import(
      '../packages/cli/src/renderer/manager/pages/model-catalog/CatalogBinding.js'
    )
    const props = { client: host.client, locale: 'en', query: '', filters: new Set(), connected: true }
    const scriptState = {
      authorityRevision: 'authority',
      runGeneration: 1,
      persistence: 'session-only' as const,
      evidence: 'script-declared' as const,
    }
    try {
      await host.client.refresh()
      await fixture.render(
        <CatalogBinding
          {...props}
          view={catalogView({
            activity: 'loading',
            scriptState,
            sourceCapabilities: ['runScript', 'refresh'],
            capabilities: ['runScript', 'refresh'],
          })}
        />,
      )
      expect((fixture.element('[aria-label="Run script"]') as HTMLButtonElement).disabled).toBe(false)
      expect((fixture.element('[aria-label="Refresh models: Provider A"]') as HTMLButtonElement).disabled).toBe(true)
      await fixture.render(
        <CatalogBinding
          {...props}
          view={catalogView({
            activity: 'idle',
            scriptState,
            sourceCapabilities: ['cancelScript', 'refresh'],
            capabilities: ['cancelScript', 'refresh'],
          })}
        />,
      )
      expect((fixture.element('[aria-label="Cancel script"]') as HTMLButtonElement).disabled).toBe(false)
      expect((fixture.element('[aria-label="Refresh models: Provider A"]') as HTMLButtonElement).disabled).toBe(false)
      expect(host.commands).toEqual([])
    } finally {
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('saves a write-only full configuration without running and sends narrow Run/Cancel intents', async () => {
    const fixture = reactManagerFixture()
    const host = catalogFixture()
    const { ModelServicesPage } = await import('../packages/cli/src/renderer/manager/pages/ModelServicesPage.js')
    const legacy = { loading: false, entries: [], providers: [] }
    const registry = {
      management: host.client,
      subscribe: () => () => {},
      refresh: async () => {},
      snapshot: () => legacy,
    } as unknown as ModelProviderRegistry
    try {
      await host.client.refresh()
      await fixture.render(<ModelServicesPage registry={registry} locale="en" />)
      expect(host.commands).toEqual([])
      await configure(fixture)
      await fixture.type('[aria-label="Executable or script path"]', 'node')
      await fixture.type('[aria-label="Working directory"]', '/fixture')
      await fixture.click('[aria-label="Add argument"]')
      await fixture.type('[aria-label="Arguments 1"]', './models.cjs')
      await fixture.click('.cxmc-editor-actions button:last-child')
      expect(host.commands).toHaveLength(1)
      expect(host.commands[0]).toMatchObject({
        operation: 'configureScript',
        bindingRef: 'binding-a',
        scopeRevision: 'scope-1',
        expectedRevision: '1',
        mode: 'replace',
        config: {
          schemaVersion: 1,
          command: { kind: 'exec', executable: 'node', args: ['./models.cjs'] },
          cwd: '/fixture',
          environment: { inherit: false, refs: {}, values: {} },
        },
      })
      expect(fixture.document.querySelector('.cxmc-editor')).toBeNull()
      expect(JSON.stringify(host.client.snapshot())).not.toMatch(/models\.cjs|\/fixture|executable|environment/)
      await fixture.click('[aria-label="Run script"]')
      await fixture.click('[aria-label="Cancel script"]')
      expect(host.commands.slice(1)).toEqual([
        { operation: 'runScript', bindingRef: 'binding-a', scopeRevision: 'scope-1', expectedRevision: '2' },
        { operation: 'cancelScript', bindingRef: 'binding-a', scopeRevision: 'scope-1', expectedRevision: '3' },
      ])
      expect(fixture.document.querySelector('.cxmc-confirm')).toBeNull()
      await configure(fixture)
      expect((fixture.element('[aria-label="Executable or script path"]') as HTMLInputElement).value).toBe('')
      expect((fixture.element('[aria-label="Working directory"]') as HTMLInputElement).value).toBe('')
    } finally {
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('requires an explicit shell mode and preserves the draft across revision and scope changes', async () => {
    const fixture = reactManagerFixture()
    const { ScriptEditor } = await import('../packages/cli/src/renderer/manager/pages/model-catalog/ScriptEditor.js')
    const saved: unknown[] = []
    const props = {
      locale: 'en',
      close: () => {},
      save: async (...args: unknown[]) => {
        saved.push(args)
        return { status: 'applied' as const }
      },
    }
    try {
      await fixture.render(
        <ScriptEditor
          {...props}
          view={catalogView({
            scriptState: {
              authorityRevision: 'authority',
              runGeneration: 1,
              persistence: 'session-only',
              evidence: 'script-declared',
            },
          })}
        />,
      )
      expect((fixture.element('[aria-label="Model result"]') as HTMLInputElement).value).toBe('Supplement model list')
      await fixture.choose('[aria-label="Execution mode"]', 'Shell command')
      await fixture.type('input[aria-label="Shell command"]', 'node ./models.cjs')
      await fixture.type('[aria-label="Working directory"]', '/fixture')
      await fixture.render(<ScriptEditor {...props} view={catalogView({ revision: '2' })} />)
      expect((fixture.element('input[aria-label="Shell command"]') as HTMLInputElement).value).toBe('node ./models.cjs')
      expect((fixture.element('.cxmc-editor-actions button:last-child') as HTMLButtonElement).disabled).toBe(true)
      await fixture.click('.cxmc-editor [role="status"] button')
      expect((fixture.element('.cxmc-editor-actions button:last-child') as HTMLButtonElement).disabled).toBe(false)
      await fixture.render(
        <ScriptEditor {...props} view={catalogView({ revision: '3', scopeRevision: 'new-scope' })} />,
      )
      expect((fixture.element('.cxmc-editor-actions button:last-child') as HTMLButtonElement).disabled).toBe(true)
      expect(saved).toEqual([])
    } finally {
      await fixture.dispose()
    }
  })
})
