import { expect, it, vi } from 'vitest'
import type { EntityDirectoryAuthority } from '../packages/cli/src/launcher/entity-directory.js'
import { createNativeViteEntityGenerationHandler } from '../packages/cli/src/launcher/vite-development-generation.js'

function fixture() {
  const register = vi.fn()
  const materialize = vi.fn(async () => [])
  const handler = createNativeViteEntityGenerationHandler(
    { register, materialize } as unknown as EntityDirectoryAuthority,
    'development',
  )
  const generation = (moduleGeneration: string) => ({
    pluginId: 'demo',
    moduleGeneration,
    version: '1.0.0',
    digest: `sha256:${'a'.repeat(64)}` as const,
    entityTemplates: [],
  })
  return { handler, generation, register, materialize }
}

it('shares a concurrent generation and keeps declarations when one window commits and another rolls back', async () => {
  const { handler, generation, register, materialize } = fixture()
  const [first, second] = await Promise.all([handler(generation('one')), handler(generation('one'))])
  expect(materialize).toHaveBeenCalledTimes(1)
  await first.commit()
  await second.rollback()
  await (await handler(generation('one'))).rollback()
  expect(register).toHaveBeenCalledTimes(1)
  expect(materialize).toHaveBeenCalledTimes(1)
  await (await handler(generation('two'))).commit()
  expect(materialize).toHaveBeenCalledTimes(2)
})

it('restores declarations only after every window rolls back and refuses a competing generation', async () => {
  const { handler, generation, register } = fixture()
  const [first, second] = await Promise.all([handler(generation('one')), handler(generation('one'))])
  await expect(handler(generation('two'))).rejects.toThrow('already has a staged entity generation')
  await first.rollback()
  expect(register).toHaveBeenCalledTimes(1)
  await second.rollback()
  expect(register).toHaveBeenCalledTimes(2)
  await (await handler(generation('two'))).commit()
})

it('releases a failed shared materialization so a corrected generation can stage', async () => {
  const { handler, generation, materialize, register } = fixture()
  materialize.mockRejectedValueOnce(new Error('materialization failed'))
  const results = await Promise.allSettled([handler(generation('one')), handler(generation('one'))])
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
  expect(register).toHaveBeenCalledTimes(2)
  await (await handler(generation('two'))).commit()
})
