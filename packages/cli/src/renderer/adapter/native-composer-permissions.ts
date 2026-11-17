import { nativeComposerThreadId, nativeModelProviderExecutionHost } from './native-model-provider-seat.js'

/** The native permissions trigger remains the sole authority for permission changes. */
export function nativeComposerPermissions(document: Document) {
  return [...document.querySelectorAll<HTMLElement>(
    '[data-codex-composer-root][data-composer-placement]',
  )].flatMap(composer => {
    const buttons = [...composer.querySelectorAll<HTMLButtonElement>(
      'button[data-composer-navigation-target="permissions"]',
    )].filter(button => button.closest('[data-codex-composer-root]') === composer)
    if (buttons.length !== 1) return []
    const trigger = buttons[0]!
    const hostId = nativeModelProviderExecutionHost(trigger) ?? 'local'
    const threadId = nativeComposerThreadId(composer)
    const ids = trigger.getAttribute('aria-describedby')?.split(/\s+/u) ?? []
    const describedLabel = ids.map(id => document.getElementById(id)?.textContent?.trim()).find(Boolean)
    const label = describedLabel ?? trigger.textContent?.trim()
    return [{
      composer,
      trigger,
      hostId,
      threadId,
      label: label && label.length <= 128 && !/[\0\r\n]/u.test(label) ? label : undefined,
      loading: trigger.getAttribute('aria-busy') === 'true',
    }]
  })
}
