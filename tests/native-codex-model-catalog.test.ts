import { expect, test, vi } from 'vitest'
import { nativeCodexModelCatalog } from '../packages/cli/src/launcher/native-codex-model-catalog.js'

const row = (model: string, extra = {}) => ({ id: model, model, displayName: model, hidden: false, ...extra })
test('native model catalog retains the visible default and actual Fast support across pages', async () => {
  const request = vi.fn().mockResolvedValueOnce({
    data: [row('first', { isDefault: true, additionalSpeedTiers: ['fast'] })],
    nextCursor: 'next',
  })
    .mockResolvedValueOnce({ data: [row('slow'), row('hidden', { hidden: true, isDefault: true })], nextCursor: null })
  expect(await nativeCodexModelCatalog(request)).toMatchObject({
    defaultModelId: 'first',
    models: [{ id: 'first', supportsFastMode: true }, { id: 'slow', supportsFastMode: false }],
  })
  expect(request).toHaveBeenLastCalledWith({ limit: 100, includeHidden: false, cursor: 'next' })
})
test('duplicate models, malformed pages and failed native catalog reads stay unavailable', async () => {
  expect(await nativeCodexModelCatalog(async () => ({ data: [row('duplicate'), row('duplicate')] }))).toBeUndefined()
  expect(await nativeCodexModelCatalog(async () => ({ data: [{ model: 'incomplete' }] }))).toBeUndefined()
  expect(
    await nativeCodexModelCatalog(async () => {
      throw new Error('unavailable')
    }),
  ).toBeUndefined()
})
