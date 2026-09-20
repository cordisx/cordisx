import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { REACT_MANAGER_STYLES } from '../packages/cli/src/renderer/manager/styles.js'

function zIndex(styles: string, selector: string): number {
  const start = styles.indexOf(`${selector} {`)
  const end = start === -1 ? -1 : styles.indexOf('}', start)
  const block = start === -1 || end === -1 ? undefined : styles.slice(start, end)
  const value = block?.match(/z-index:\s*(\d+)/u)?.[1]
  if (value === undefined) throw new Error(`Missing z-index for ${selector}`)
  return Number(value)
}

it('keeps interactive notifications above the Manager backdrop', async () => {
  const notificationStyles = await readFile(
    new URL('../packages/cli/src/renderer/notifications/styles.css', import.meta.url),
    'utf8',
  )
  expect(zIndex(notificationStyles, '.cxn-stack')).toBeGreaterThan(zIndex(REACT_MANAGER_STYLES, '.cxr-backdrop'))
  expect(notificationStyles).toMatch(/\.cxn-card, \.cxn-undo\s*\{[^}]*pointer-events:\s*auto/su)
})
