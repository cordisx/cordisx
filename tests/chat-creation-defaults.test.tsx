import React, { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dom, root } from './helpers/host-react-form.js'
import { managerModel, managerRouter, managerSnapshot } from './helpers/react-manager.js'
import { registerChannelSettingsDestination } from '../packages/cli/src/renderer/channel-settings-destination.js'
import { primaryFor } from '../packages/cli/src/renderer/manager/model/routes.js'
import { managerHeaderBackRoute } from '../packages/cli/src/renderer/manager/model/header-navigation.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({ BrandMark: () => <span /> }))

let Navigation: typeof import('../packages/cli/src/renderer/manager/components/Navigation.js').Navigation
let ChatCreationDefaultsAction:
  typeof import('../packages/cli/src/renderer/manager/components/ChatCreationDefaultsAction.js').ChatCreationDefaultsAction
let ChatExecutionPage:
  typeof import('../packages/cli/src/renderer/manager/pages/ChatExecutionPage.js').ChatExecutionPage
let ChannelExecutionWorkflow:
  typeof import('../packages/cli/src/renderer/channel-execution-workflow.js').ChannelExecutionWorkflow
beforeEach(async () => {
  ;({ Navigation } = await import('../packages/cli/src/renderer/manager/components/Navigation.js'))
  ;({ ChatCreationDefaultsAction } = await import(
    '../packages/cli/src/renderer/manager/components/ChatCreationDefaultsAction.js'
  ))
  ;({ ChatExecutionPage } = await import('../packages/cli/src/renderer/manager/pages/ChatExecutionPage.js'))
  ;({ ChannelExecutionWorkflow } = await import('../packages/cli/src/renderer/channel-execution-workflow.js'))
})

function channelSettings() {
  const source = 'file:///channel-fixture'
  const snapshot = managerSnapshot({
    plugins: [{ id: 'channel', source, status: 'active' }] as never,
    settingsNavigationItems: [{
      id: 'channel:channels',
      owner: 'channel',
      group: 'after-settings',
      navigationGroup: 'external-accounts',
      title: 'Channels',
      description: '',
      pageTitle: 'Channels',
      pageDescription: '',
      icon: 'host:settings',
      order: 0,
      disabled: false,
      route: { id: 'channels' },
    }],
    navigation: {
      routes: [{
        owner: 'channel',
        id: 'preferences-defaults',
        valid: true,
        authorized: true,
        effectivePointPolicy: 'allow',
        definition: {
          outlet: 'manager.content',
          path: '/manager/channel/preferences/new-chats',
          page: 'preferences-defaults',
        },
      }] as never,
      pages: [{ owner: 'channel', id: 'preferences-defaults' }] as never,
      outlets: [],
    },
  })
  const dispose = registerChannelSettingsDestination(dom.window.document, {
    owner: 'channel',
    source,
    routeId: 'preferences-defaults',
    live: () => true,
  })
  return { snapshot, dispose }
}

describe('Host new-chat defaults independent of Channel settings', () => {
  it('opens general defaults from the model-services icon and keeps Channel navigation independent', async () => {
    const channel = channelSettings(), router = managerRouter()
    try {
      await act(async () =>
        root.render(
          <>
            <Navigation snapshot={channel.snapshot} router={router} />
            <ChatCreationDefaultsAction router={router} locale="en" />
          </>,
        )
      )
      expect(dom.window.document.querySelector('[data-tab="chat-execution"]')).toBeNull()
      const defaults = dom.window.document.querySelector<HTMLButtonElement>('[data-chat-creation-defaults-action]')
      expect(defaults?.getAttribute('aria-label')).toBe('New chat defaults')
      expect(defaults?.querySelector('svg')).not.toBeNull()
      await act(async () => defaults!.click())
      expect(router.openDetail).toHaveBeenLastCalledWith({ kind: 'primary', page: 'model-services' }, {
        kind: 'chat-execution',
      })
      await act(async () =>
        dom.window.document.querySelector<HTMLButtonElement>('[data-settings-navigation-item="channel:channels"]')!
          .click()
      )
      expect(router.navigate).toHaveBeenLastCalledWith({
        kind: 'manager-content',
        id: 'channel:channels',
        reference: { id: 'channels' },
      })
      await act(async () => {
        channel.dispose()
        root.render(<Navigation snapshot={managerSnapshot()} router={managerRouter({ kind: 'chat-execution' })} />)
      })
      expect(dom.window.document.querySelector('[data-tab="model-services"]')?.getAttribute('aria-current')).toBe(
        'page',
      )
      expect(primaryFor({ kind: 'chat-execution' })).toBe('model-services')
      expect(managerHeaderBackRoute({ kind: 'chat-execution' }, undefined, { kind: 'primary', page: 'plugins' }))
        .toEqual({ kind: 'primary', page: 'model-services' })
    } finally {
      channel.dispose()
    }
  })

  it('reads and saves the profile defaults through the Host form with an available Channel settings page', async () => {
    const channel = channelSettings(), lifetime = new AbortController()
    const run = vi.fn(async (action: string, request: Record<string, unknown>) => ({
      status: 'applied' as const,
      execution: {
        revision: action === 'execution-defaults-set' ? 4 : 3,
        settings: action === 'execution-defaults-set' ? request.settings : { execution: 'read-only' },
      },
    }))
    const workflow = new ChannelExecutionWorkflow({
      document: dom.window.document,
      profileId: 'test',
      hostGeneration: 'one',
      lifetime: lifetime.signal,
      run: run as never,
    })
    try {
      const model = managerModel(channel.snapshot, { chatExecution: workflow })
      await act(async () => root.render(<ChatExecutionPage model={model} locale="en" />))
      expect(run).toHaveBeenCalledExactlyOnceWith('execution-defaults', {})
      expect(dom.window.document.querySelector('[data-chat-execution-form="creation-defaults"]')).not.toBeNull()
      expect(dom.window.document.body.textContent).not.toContain('Open Channel settings')
      const plan = [...dom.window.document.querySelectorAll<HTMLElement>(
        '[data-config-path="workMode"] .t-radio-button',
      )].find(button => button.textContent?.trim() === 'Plan')
      expect(plan).toBeDefined()
      await act(async () => plan!.click())
      await act(async () =>
        dom.window.document.querySelector('form')!.dispatchEvent(
          new dom.window.Event('submit', { bubbles: true, cancelable: true }),
        )
      )
      expect(run).toHaveBeenLastCalledWith('execution-defaults-set', {
        expectedRevision: 3,
        settings: expect.objectContaining({ execution: 'read-only', workMode: 'plan' }),
      })
    } finally {
      channel.dispose()
      lifetime.abort()
    }
  })

  it('reports an unavailable Host runtime without sending the user to Channel settings', async () => {
    const channel = channelSettings()
    try {
      await act(async () => root.render(<ChatExecutionPage model={managerModel(channel.snapshot)} locale="en" />))
      expect(dom.window.document.body.textContent).toContain('Execution settings unavailable')
      expect(dom.window.document.body.textContent).not.toContain('Open Channel settings')
    } finally {
      channel.dispose()
    }
  })
})
