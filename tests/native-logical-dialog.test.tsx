import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { dom, setup } from './fixtures/model-provider-selector-harness.js'

describe('logical continuation confirmation', () => {
  it('offers navigation to an authorized earlier conversation outside the switch dialog', async () => {
    const { openLogicalSource } = await setup('shared', false, { previous: 'earlier' })
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item =>
      item.textContent === 'Earlier conversation'
    )!
    expect(button).toBeDefined()
    await act(async () => button.click())
    expect(openLogicalSource).toHaveBeenCalledWith('earlier')
  })
  it('offers the committed destination after a continuation send is interrupted', async () => {
    let destination: string | undefined
    const { update, openLogicalSource } = await setup('shared', false, { next: () => destination })
    expect(document.body.textContent).not.toContain('Later conversation')
    destination = 'committed-destination'
    await update({ submissionError: 'provider-switch-reconciliation-required' })
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item =>
      item.textContent === 'Later conversation'
    )!
    expect(button).toBeDefined()
    await act(async () => button.click())
    expect(openLogicalSource).toHaveBeenCalledWith('committed-destination')
  })
  it('requires separate history consent and resets it when the mode changes', async () => {
    const { update, confirmLogicalSubmission } = await setup()
    await update({
      confirmation: {
        confirmationId: 'confirmation-token',
        expectedSelectionRevision: 3,
        target: { providerId: 'second', model: 'shared', generation: 2 },
        threadId: 't1',
        logical: {
          recommended: 'fork',
          forkAvailable: true,
          linkedAvailable: true,
          chain: { links: [{ source: 'earlier', destination: 't1', mode: 'linked' }], truncated: true },
        },
      },
    })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('both sessions may appear in the list, and ungrouped order may change')
    expect(dialog.textContent).toContain('Target service: second')
    expect(dialog.textContent).toContain('Model: shared')
    expect(dialog.textContent).toContain('earlier → t1')
    expect(dialog.textContent).toContain('Earlier relationships are unavailable.')
    const radios = dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]')
    const checkbox = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    const submit = buttons.find(button => button.textContent === 'Continue')!
    expect(radios[0]!.checked).toBe(true)
    expect(submit.disabled).toBe(true)
    await act(async () => checkbox.click())
    expect(submit.disabled).toBe(false)
    await act(async () => radios[1]!.click())
    expect(dialog.textContent).toContain('Authorized history may be sent to the target service')
    expect(checkbox.checked).toBe(false)
    expect(submit.disabled).toBe(true)
    const remember = dialog.querySelector<HTMLSelectElement>('select')!
    expect(remember.value).toBe('once')
    await act(async () => {
      remember.value = 'conversation'
      remember.dispatchEvent(new remember.ownerDocument.defaultView!.Event('change', { bubbles: true }))
    })
    expect(submit.disabled).toBe(true)
    await act(async () => checkbox.click())
    await act(async () => submit.click())
    expect(confirmLogicalSubmission).toHaveBeenCalledWith('linked', 'conversation', undefined)
  })

  it('explains an old fresh preference and requires consent when clearing it', async () => {
    const { update, confirmLogicalSubmission } = await setup()
    await update({
      confirmation: {
        confirmationId: 'confirmation-token',
        expectedSelectionRevision: 3,
        target: { providerId: 'second', model: 'shared', generation: 2 },
        threadId: 't1',
        logical: { recommended: 'linked', forkAvailable: false, linkedAvailable: true, legacyFreshPreference: true },
      },
    })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const remember = dialog.querySelector<HTMLSelectElement>('select')!
    await act(async () => {
      remember.value = 'inherit'
      remember.dispatchEvent(new remember.ownerDocument.defaultView!.Event('change', { bubbles: true }))
    })
    const submit = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button =>
      button.textContent === 'Continue'
    )!
    expect(dialog.textContent).toContain('saved fresh preference no longer applies')
    expect(dialog.querySelectorAll('input[type="radio"]')).toHaveLength(2)
    expect(submit.disabled).toBe(true)
    expect([...dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]')].every(radio => !radio.checked)).toBe(
      true,
    )
    await act(async () => dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click())
    expect(submit.disabled).toBe(true)
    await act(async () => dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    expect(submit.disabled).toBe(false)
    await act(async () => submit.click())
    expect(confirmLogicalSubmission).toHaveBeenCalledWith('linked', 'inherit', undefined)
  })

  it('cancels the switch before opening an authorized earlier session', async () => {
    const { update, confirmLogicalSubmission, openLogicalSource } = await setup()
    await update({
      confirmation: {
        confirmationId: 'confirmation-token',
        expectedSelectionRevision: 3,
        target: { providerId: 'second', model: 'shared', generation: 2 },
        threadId: 't1',
        logical: {
          recommended: 'linked',
          forkAvailable: false,
          linkedAvailable: true,
          chain: { links: [{ source: 'earlier', destination: 't1', mode: 'linked' }], truncated: false },
        },
      },
    })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    await act(async () => dialog.querySelector('summary')!.click())
    const source = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button =>
      button.textContent === 'earlier'
    )!
    await act(async () => source.click())
    expect(confirmLogicalSubmission).toHaveBeenCalledWith(undefined, undefined, undefined)
    expect(openLogicalSource).toHaveBeenCalledWith('earlier')
  })

  it('cannot use an empty continuation when no bound mode is available', async () => {
    const { update, confirmLogicalSubmission } = await setup()
    await update({
      confirmation: {
        confirmationId: 'confirmation-token',
        expectedSelectionRevision: 3,
        target: { providerId: 'second', model: 'shared', generation: 2 },
        threadId: 't1',
        logical: {
          recommended: 'linked',
          forkAvailable: false,
          linkedAvailable: false,
          channelBound: true,
          channelChallenge: 'A'.repeat(32),
        },
      },
    })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const radios = dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]')
    const submit = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button =>
      button.textContent === 'Continue'
    )!
    expect(radios[0]!.disabled).toBe(true)
    expect(radios[1]!.disabled).toBe(true)
    expect(radios).toHaveLength(2)
    expect(dialog.textContent).toContain('/continue-provider authorize-desktop linked second shared')
    expect(dialog.textContent).toContain('--challenge=' + 'A'.repeat(32))
    expect(dialog.textContent).toContain('Check the account, source conversation and relevant authorization')
    expect(submit.disabled).toBe(true)
    expect(confirmLogicalSubmission).not.toHaveBeenCalled()
  })
})
