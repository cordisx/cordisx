import { expect, test, vi } from 'vitest'
import { nativeApiProviderRequest } from '../packages/cli/src/launcher/native-api-provider-request.js'

test('creation defaults resolve before the existing credential lease and keep it with the returned thread', async () => {
  const dispose = vi.fn()
  const lease = {
    endpoint: { baseUrl: 'http://127.0.0.1/v1', wireApi: 'responses' as const },
    auth: { scheme: 'none' as const },
    dispose,
    serviceGeneration: 'g',
  }
  const request = vi.fn(async () => ({ thread: { id: 'new-chat' } }))
  const prepareManaged = vi.fn(async () => lease)
  const leases = new Map()
  const dispatch = nativeApiProviderRequest({
    request,
    prepareStart: async params => ({ ...params, modelProvider: 'managed', model: 'chosen' }),
    managed: id => id === 'managed',
    prepareManaged,
    prepareConfigured: vi.fn(),
    leases,
  })
  expect(await dispatch('thread/start', { cwd: '/repo' })).toMatchObject({ thread: { id: 'new-chat' } })
  expect(prepareManaged).toHaveBeenCalledWith('managed')
  expect(request).toHaveBeenCalledWith(
    'thread/start',
    expect.objectContaining({
      modelProvider: 'managed',
      model: 'chosen',
      config: { 'model_providers.managed': expect.objectContaining({ requires_openai_auth: false }) },
    }),
  )
  expect(leases.get('new-chat')).toBe(lease)
  expect(dispose).not.toHaveBeenCalled()
})

test('configured defaults use only their configured overrides', async () => {
  const request = vi.fn(async () => ({})),
    prepareConfigured = vi.fn(async () => ({ 'model_providers.custom': { private: 'owned' } }))
  const dispatch = nativeApiProviderRequest({
    request,
    prepareStart: async params => ({ ...params, modelProvider: 'custom' }),
    managed: () => false,
    prepareManaged: vi.fn(),
    prepareConfigured,
    leases: new Map(),
  })
  await dispatch('thread/start', {})
  expect(prepareConfigured).toHaveBeenCalledWith('custom')
  expect(request).toHaveBeenCalledWith('thread/start', expect.objectContaining({ modelProvider: 'custom' }), {
    'model_providers.custom': { private: 'owned' },
  })
})

test('failed managed starts release the acquired credential lease', async () => {
  const dispose = vi.fn()
  const lease = {
    endpoint: { baseUrl: 'http://127.0.0.1/v1', wireApi: 'responses' as const },
    auth: { scheme: 'none' as const },
    dispose,
    serviceGeneration: 'g',
  }
  const dispatch = nativeApiProviderRequest({
    request: async () => {
      throw new Error('lost')
    },
    prepareStart: async params => ({ ...params, modelProvider: 'managed' }),
    managed: () => true,
    prepareManaged: async () => lease,
    prepareConfigured: vi.fn(),
    leases: new Map(),
  })
  await expect(dispatch('thread/start', {})).rejects.toThrow('lost')
  expect(dispose).toHaveBeenCalledOnce()
})
