import React from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ManagerContentConfigSourceV1,
  ManagerContentConfigSubscriptionClosedV1,
  ManagerContentPluginConfigFormProjectionV1,
} from '@cordisx/protocol/manager-content-navigation/v4'

vi.mock('../packages/cli/src/renderer/host-ui/HostForm.js', () => ({
  HostForm: (
    { plugin }: { plugin: { configuration: { fields: readonly { choices?: readonly { label: string }[] }[] } } },
  ) => (
    <div
      data-host-form-fixture="true"
      data-choice-labels={plugin.configuration.fields.flatMap(field => field.choices?.map(choice => choice.label) ?? [])
        .join('|')}
    >
      <button type="button" data-host-form-draft-fixture="true" data-draft="">draft control</button>
    </div>
  ),
}))

import { mountManagerContentConfigForm } from '../packages/cli/src/renderer/manager-content-config-form.js'
import type { ManagerContentConfigBindingHandle } from '../packages/cli/src/renderer/manager-content-config.js'

const previous = {
  window: globalThis.window,
  document: globalThis.document,
  HTMLElement: globalThis.HTMLElement,
  Element: globalThis.Element,
  Node: globalThis.Node,
  MutationObserver: globalThis.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
}

afterEach(() => Object.assign(globalThis, previous))

describe('Host Manager config form mount', () => {
  it('materializes defaults once, subscribes to the Host source, and unsubscribes on route unmount', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: false,
    })
    const binding = {
      bindingId: 'cx-manager-config:test',
      identity: { source: 'file:///chatroom.ts', pluginId: 'chatroom' },
      scope: { profileId: 'default', generation: 'chatroom-g1' },
      declarationId: 'settings',
      namespace: 'chatroom',
    } as const
    const body: ManagerContentPluginConfigFormProjectionV1 = {
      kind: 'plugin-config-form',
      binding,
      sequence: 0,
      configuration: {
        version: 2,
        identity: binding.identity,
        scope: binding.scope,
        namespace: 'chatroom',
        schema: { kind: 'standard', renderable: false },
        value: { shortcutPolicy: 'enter' },
        revision: 3,
        lastGoodRevision: 3,
        applies: 'live',
        writable: true,
        secrets: [],
      },
      draft: {
        baseRevision: 3,
        dirty: false,
        value: { shortcutPolicy: 'enter' },
        validation: { state: 'unvalidated' },
      },
    }
    const closed: ManagerContentConfigSubscriptionClosedV1 = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-config-subscription-close.v1.schema.json',
      contract: 'cordisx.manager-content-config-subscription-close/v1',
      schemaVersion: 1,
      subscriptionId: 'cx-manager-config-sub:test',
      binding,
      status: 'closed',
      code: 'unsubscribed',
    }
    const unsubscribe = vi.fn(async () => closed)
    const execute = vi.fn(async () => ({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-config-result.v1.schema.json' as const,
      contract: 'cordisx.manager-content-config-result/v1' as const,
      schemaVersion: 1 as const,
      commandId: 'defaults',
      binding,
      expectedRevision: 3,
      operation: 'defaults.materialize' as const,
      status: 'preserved' as const,
      code: 'values-present' as const,
      revision: 3,
    }))
    const source = {
      binding,
      snapshot: async () => ({ status: 'available' as const, body }),
      execute,
      subscribe: async () => ({
        status: 'subscribed' as const,
        subscription: {
          descriptor: { subscriptionId: 'cx-manager-config-sub:test', binding, afterSequence: 0, replayThrough: 0 },
          pages: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) },
          closed: new Promise<never>(() => {}),
          unsubscribe,
        },
      }),
    } as unknown as ManagerContentConfigSourceV1
    const handle = {
      owner: 'chatroom',
      declarationId: 'settings',
      moduleGeneration: 'chatroom-g1',
      body: {
        kind: 'plugin-config-form' as const,
        namespace: 'chatroom',
        defaultMaterialization: {
          mode: 'missing-only' as const,
          fields: [{ path: ['shortcutPolicy'] as const, value: 'enter' }],
        },
      },
      source,
      snapshotForHost: () => ({
        namespace: 'chatroom',
        schemaKind: 'schemastery' as const,
        applies: 'live' as const,
        writable: true,
        revision: 3,
        lastGoodRevision: 3,
        value: { shortcutPolicy: 'enter' },
        fields: [],
        secrets: [],
      }),
      close: () => {},
    } satisfies ManagerContentConfigBindingHandle

    const dispose = mountManagerContentConfigForm(dom.window.document.getElementById('root')!, handle, () => 'en')
    await new Promise(resolve => setImmediate(resolve))
    expect(dom.window.document.querySelector('[data-manager-content-config-host="true"]')).not.toBeNull()
    expect(dom.window.document.querySelector('[data-host-form-fixture="true"]')).not.toBeNull()
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      operation: 'defaults.materialize',
      expectedRevision: 3,
      binding,
      materializationId: 'cx-manager-default:cx-manager-config:test',
    })
    dispose()
    await new Promise(resolve => setImmediate(resolve))
    expect(unsubscribe).toHaveBeenCalledOnce()
    dom.window.close()
  })

  it('unsubscribes a source that resolves after the route was already unmounted', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: false,
    })
    const binding = {
      bindingId: 'cx-manager-config:delayed',
      identity: { source: 'file:///chatroom.ts', pluginId: 'chatroom' },
      scope: { profileId: 'default', generation: 'chatroom-g1' },
      declarationId: 'settings',
      namespace: 'chatroom',
    } as const
    const body: ManagerContentPluginConfigFormProjectionV1 = {
      kind: 'plugin-config-form',
      binding,
      sequence: 0,
      configuration: {
        version: 2,
        identity: binding.identity,
        scope: binding.scope,
        namespace: 'chatroom',
        schema: { kind: 'standard', renderable: false },
        value: {},
        revision: 0,
        lastGoodRevision: 0,
        applies: 'live',
        writable: true,
        secrets: [],
      },
      draft: { baseRevision: 0, dirty: false, value: {}, validation: { state: 'unvalidated' } },
    }
    const closed: ManagerContentConfigSubscriptionClosedV1 = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-config-subscription-close.v1.schema.json',
      contract: 'cordisx.manager-content-config-subscription-close/v1',
      schemaVersion: 1,
      subscriptionId: 'cx-manager-config-sub:delayed',
      binding,
      status: 'closed',
      code: 'unsubscribed',
    }
    const unsubscribe = vi.fn(async () => closed)
    let resolveSubscribe!: (value: Awaited<ReturnType<ManagerContentConfigSourceV1['subscribe']>>) => void
    const source = {
      binding,
      snapshot: async () => ({ status: 'available' as const, body }),
      execute: vi.fn(),
      subscribe: () =>
        new Promise<Awaited<ReturnType<ManagerContentConfigSourceV1['subscribe']>>>(resolve => {
          resolveSubscribe = resolve
        }),
    } as unknown as ManagerContentConfigSourceV1
    const handle = {
      owner: 'chatroom',
      declarationId: 'settings',
      moduleGeneration: 'chatroom-g1',
      body: { kind: 'plugin-config-form' as const, namespace: 'chatroom' },
      source,
      snapshotForHost: () => ({
        namespace: 'chatroom',
        schemaKind: 'schemastery' as const,
        applies: 'live' as const,
        writable: true,
        revision: 0,
        lastGoodRevision: 0,
        value: {},
        fields: [],
        secrets: [],
      }),
      close: () => {},
    } satisfies ManagerContentConfigBindingHandle

    const dispose = mountManagerContentConfigForm(dom.window.document.getElementById('root')!, handle, () => 'en')
    await new Promise(resolve => setImmediate(resolve))
    dispose()
    resolveSubscribe({
      status: 'subscribed',
      subscription: {
        descriptor: { subscriptionId: 'cx-manager-config-sub:delayed', binding, afterSequence: 0, replayThrough: 0 },
        pages: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) },
        closed: Promise.resolve(closed),
        unsubscribe,
      } as never,
    })
    await new Promise(resolve => setImmediate(resolve))
    expect(unsubscribe).toHaveBeenCalledOnce()
    dom.window.close()
  })

  it('refreshes localized choice labels in place when the active Host locale changes', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: false,
    })
    const binding = {
      bindingId: 'cx-manager-config:locale',
      identity: { source: 'file:///chatroom.ts', pluginId: 'chatroom' },
      scope: { profileId: 'default', generation: 'chatroom-g1' },
      declarationId: 'settings',
      namespace: 'chatroom',
    } as const
    let locale = 'en'
    let localeListener: (() => void) | undefined
    const configuration = () => ({
      namespace: 'chatroom',
      schemaKind: 'schemastery' as const,
      applies: 'live' as const,
      writable: true,
      revision: 0,
      lastGoodRevision: 0,
      value: { shortcutPolicy: 'enter' },
      secrets: [],
      fields: [{
        namespace: 'chatroom',
        path: ['shortcutPolicy'] as const,
        type: 'union',
        value: 'enter',
        disabled: false,
        required: false,
        choices: locale === 'zh-CN'
          ? [{ value: 'enter' as const, label: 'Enter 发送' }, {
            value: 'mod-enter' as const,
            label: 'Command/Ctrl+Enter 发送',
          }]
          : [{ value: 'enter' as const, label: 'Enter sends' }, {
            value: 'mod-enter' as const,
            label: 'Command/Ctrl+Enter sends',
          }],
      }],
    })
    const body: ManagerContentPluginConfigFormProjectionV1 = {
      kind: 'plugin-config-form',
      binding,
      sequence: 0,
      configuration: {
        version: 2,
        identity: binding.identity,
        scope: binding.scope,
        namespace: 'chatroom',
        schema: { kind: 'standard', renderable: false },
        value: { shortcutPolicy: 'enter' },
        revision: 0,
        lastGoodRevision: 0,
        applies: 'live',
        writable: true,
        secrets: [],
      },
      draft: {
        baseRevision: 0,
        dirty: false,
        value: { shortcutPolicy: 'enter' },
        validation: { state: 'unvalidated' },
      },
    }
    const handle = {
      owner: 'chatroom',
      declarationId: 'settings',
      moduleGeneration: 'chatroom-g1',
      contractVersion: 2 as const,
      body: { kind: 'plugin-config-form' as const, namespace: 'chatroom' },
      source: {
        binding,
        snapshot: async () => ({ status: 'available' as const, body }),
        execute: vi.fn(),
        subscribe: async () => ({ status: 'unavailable' as const, code: 'disposed' as const }),
      } as unknown as ManagerContentConfigSourceV1,
      snapshotForHost: configuration,
      close: () => {},
    } satisfies ManagerContentConfigBindingHandle
    const dispose = mountManagerContentConfigForm(
      dom.window.document.getElementById('root')!,
      handle,
      () => locale,
      listener => {
        localeListener = listener
        return () => {
          localeListener = undefined
        }
      },
    )
    expect(dom.window.document.querySelector('[data-host-form-fixture]')?.getAttribute('data-choice-labels')).toBe(
      'Enter sends|Command/Ctrl+Enter sends',
    )
    const draft = dom.window.document.querySelector<HTMLButtonElement>('[data-host-form-draft-fixture]')!
    draft.dataset.draft = 'unsaved-choice'
    draft.focus()
    locale = 'zh-CN'
    localeListener?.()
    await new Promise(resolve => setImmediate(resolve))
    expect(dom.window.document.querySelector('[data-host-form-fixture]')?.getAttribute('data-choice-labels')).toBe(
      'Enter 发送|Command/Ctrl+Enter 发送',
    )
    expect(dom.window.document.querySelector('[data-host-form-draft-fixture]')).toBe(draft)
    expect(draft.dataset.draft).toBe('unsaved-choice')
    expect(dom.window.document.activeElement).toBe(draft)
    dispose()
    expect(localeListener).toBeUndefined()
    await new Promise(resolve => setImmediate(resolve))
    dom.window.close()
  })
})
