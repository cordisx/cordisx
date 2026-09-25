// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { nativeModelProviderInteractionAllowed } from '../packages/cli/src/renderer/adapter/native-model-provider-interaction.js'

describe('native model provider modal isolation', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<body><button id="model">Model</button></body>'
  })

  it('allows the exact current startup-owned modal while rejecting a lookalike business modal', () => {
    const trigger = document.querySelector<HTMLElement>('#model')!
    const receipt = { generation: 'startup', nonce: 'receipt', timeOrigin: performance.timeOrigin, url: location.href }
    const startup = document.createElement('dialog')
    startup.dataset.cordisxStartup = receipt.generation
    startup.id = `cordisx-startup-${receipt.nonce}`
    startup.setAttribute('open', '')
    startup.setAttribute('aria-modal', 'true')
    startup.getClientRects = () => [{ width: 100, height: 100 }] as unknown as DOMRectList
    document.documentElement.append(startup)
    Object.defineProperty(window, '__cordisxStartupDocument', {
      configurable: true,
      value: {
        snapshot: () => ({ receipt }),
        ownsDialog: (candidate: HTMLElement, value: typeof receipt) => candidate === startup && value === receipt,
      },
    })

    expect(nativeModelProviderInteractionAllowed(trigger)).toBe(true)
    const business = startup.cloneNode() as HTMLDialogElement
    business.id = startup.id
    business.getClientRects = () => [{ width: 100, height: 100 }] as unknown as DOMRectList
    document.documentElement.append(business)
    expect(nativeModelProviderInteractionAllowed(trigger)).toBe(false)
    delete (window as typeof window & { __cordisxStartupDocument?: unknown }).__cordisxStartupDocument
  })
})
