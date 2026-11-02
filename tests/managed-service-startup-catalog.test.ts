import { expect, it } from 'vitest'
import { validateStartupCatalog } from '../packages/cli/src/launcher/managed-service-startup-catalog.js'

it('uses UTF-16 order to break equal UTF-8 catalog bytes in either input order', () => {
  const aliases = [String.fromCharCode(0xd800), String.fromCharCode(0xfffd)]
  const digest = 'sha256:f423f1285a060369c5d7ad6cd7bbe3dc316c23aac6e244e1fbe7af3a01d78fff'
  for (const modelIds of [aliases, [...aliases].reverse()]) {
    expect(validateStartupCatalog({
      state: 'known',
      generation: 'utf8-tie',
      modelIds,
      digest,
    })).toBe(true)
  }
})
