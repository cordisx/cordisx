import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const lint = new ESLint()
const filePath = 'packages/cli/src/renderer/model-provider-selector.tsx'

describe('model-menu authoring policy', () => {
  it('enforces the policy on the actual selector even when changed-file lint only checks additions', async () => {
    const [result] = await lint.lintFiles(filePath)
    expect(result?.messages).toEqual([])
  })
  it.each([
    'switching',
    'accepted',
    'switched',
    'updated',
    'busy',
    'failed',
    'loadFailed',
    'unavailable',
    'loading',
    'switchUnsupported',
    'switchReconciliation',
    'unsupportedIntent',
    'submitRejected',
    'actionFailed',
  ])(
    'blocks rendering %s feedback in the selector',
    async key => {
      const [result] = await lint.lintText(`const view = <div>{copy.${key}}</div>`, { filePath })
      expect(result?.messages.some(message => message.ruleId === 'no-restricted-syntax')).toBe(true)
    },
  )
  it('blocks conditional and formatted message children', async () => {
    const [result] = await lint.lintText(
      `const view = <div>{failed ? copy.actionFailed : format(copy.accepted)}</div>`,
      { filePath },
    )
    expect(result?.messages.filter(message => message.ruleId === 'no-restricted-syntax')).toHaveLength(2)
  })
  it('blocks readiness-row imports and the old local feedback render path', async () => {
    const [result] = await lint.lintText(
      `import { ModelStartupStatus } from './model-startup-status.js'; const view = <div>{feedback}</div>`,
      { filePath },
    )
    expect(result?.messages.map(message => message.ruleId)).toEqual([
      'no-restricted-imports',
      'no-restricted-syntax',
    ])
  })
  it.each([
    'const view = <div role="alert">Operation failed</div>',
    'const view = <span aria-live="polite">Saved</span>',
    'const view = <div dangerouslySetInnerHTML={{ __html: message }} />',
    'menu.appendChild(document.createElement("div"))',
    'menu.insertAdjacentHTML("beforeend", message)',
    'menu.textContent = message',
  ])('blocks an ad-hoc message insertion path: %s', async source => {
    const [result] = await lint.lintText(source, { filePath })
    expect(result?.messages.some(message => message.ruleId === 'no-restricted-syntax')).toBe(true)
  })
  it('allows provider icons, durable selection labels and notification calls', async () => {
    const [result] = await lint.lintText(
      `import { ModelStartupIcon } from './model-startup-status.js';
       const view = <button title={copy.nextSend} disabled={switching} onClick={() => feedback.show('selection.failed')}>{copy.choose}</button>`,
      { filePath },
    )
    expect(result?.messages).toEqual([])
  })
  it('allows safe action copy without creating inline content', async () => {
    const [result] = await lint.lintText(
      `const view = <>{entries.map(entry => <ProviderAction entry={entry} failed={copy.actionFailed} />)}</>`,
      { filePath },
    )
    expect(result?.messages).toEqual([])
  })
  it('preserves search empty results, accessibility and focus controls', async () => {
    const [result] = await lint.lintText(
      `const view = <div aria-busy={loading}><div role="status">{copy.noMatches}</div><button onClick={() => trigger.focus()}>Refresh</button></div>`,
      { filePath },
    )
    expect(result?.messages).toEqual([])
  })
})
