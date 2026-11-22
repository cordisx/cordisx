import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  discoverChannelTenant,
  validateChannelCredentials,
} from '../packages/cli/src/launcher/channel-credential-validation.js'

const accountId = 'cli_credential_fixture'
const tenantResult = { code: 0, data: { tenant: { tenant_key: 'fixture-tenant' } } }

afterEach(() => vi.restoreAllMocks())

describe('new Channel credentials through the actual Feishu SDK', () => {
  it('validates manually supplied tenant credentials with a fresh token exchange and redacts failures', async () => {
    const post = vi.spyOn(defaultHttpInstance, 'post')
      .mockResolvedValueOnce({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 })
      .mockRejectedValueOnce(new Error('fixture-secret and fixture-token'))
    await expect(validateChannelCredentials({ adapterId: 'feishu', accountId, secret: 'fixture-secret' }))
      .resolves.toBeUndefined()
    await expect(validateChannelCredentials({ adapterId: 'feishu', accountId, secret: 'fixture-secret' }))
      .rejects.toThrow(/^CREDENTIAL_VALIDATION_FAILED$/u)
    expect(post).toHaveBeenCalledTimes(2)
  })
  it.each([
    ['feishu', 'https://open.feishu.cn'],
    ['lark', 'https://open.larksuite.com'],
  ])('exchanges the %s credentials before the authenticated tenant lookup', async (adapterId, domain) => {
    const order: string[] = []
    const post = vi.spyOn(defaultHttpInstance, 'post').mockImplementation(async () => {
      order.push('token')
      return { code: 0, tenant_access_token: 'fixture-token', expire: 7200 }
    })
    const request = vi.spyOn(defaultHttpInstance, 'request').mockImplementation(async () => {
      order.push('tenant')
      return tenantResult
    })
    expect(await discoverChannelTenant({ adapterId, accountId, secret: 'fixture-secret' })).toBe('fixture-tenant')
    expect(post).toHaveBeenCalledExactlyOnceWith(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
      app_id: accountId,
      app_secret: 'fixture-secret',
    })
    expect(request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      url: `${domain}/open-apis/tenant/v2/tenant/query`,
      method: 'GET',
      headers: expect.objectContaining({ Authorization: 'Bearer fixture-token' }),
    }))
    expect(order).toEqual(['token', 'tenant'])
  })

  it('validates every new secret for the same App ID instead of reusing an old token', async () => {
    const post = vi.spyOn(defaultHttpInstance, 'post').mockImplementation(async (_url, body) => {
      const secret = (body as { app_secret: string }).app_secret
      return secret === 'invalid-fixture'
        ? { code: 10014, msg: 'invalid-fixture' }
        : { code: 0, tenant_access_token: `token-${secret}`, expire: 7200 }
    })
    const request = vi.spyOn(defaultHttpInstance, 'request').mockResolvedValue(tenantResult)
    for (const secret of ['old-fixture', 'new-fixture']) {
      expect(await discoverChannelTenant({ adapterId: 'feishu', accountId, secret })).toBe('fixture-tenant')
    }
    await expect(discoverChannelTenant({ adapterId: 'feishu', accountId, secret: 'invalid-fixture' }))
      .rejects.toThrow(/^TENANT_DISCOVERY_FAILED$/u)
    expect(post.mock.calls.map(([, body]) => (body as { app_secret: string }).app_secret)).toEqual([
      'old-fixture',
      'new-fixture',
      'invalid-fixture',
    ])
    expect(request.mock.calls.map(([input]) => input.headers?.Authorization)).toEqual([
      'Bearer token-old-fixture',
      'Bearer token-new-fixture',
    ])
  })

  it('keeps authenticated tenant failures and transport details out of the public error', async () => {
    vi.spyOn(defaultHttpInstance, 'post').mockResolvedValue({
      code: 0,
      tenant_access_token: 'fixture-token',
      expire: 7200,
    })
    const request = vi.spyOn(defaultHttpInstance, 'request')
      .mockRejectedValueOnce(new Error('fixture-secret and fixture-token'))
      .mockResolvedValueOnce({ code: 99991672, msg: 'fixture-token', data: {} })
    for (const code of ['TENANT_DISCOVERY_FAILED', 'TENANT_DISCOVERY_PERMISSION_DENIED']) {
      await expect(discoverChannelTenant({ adapterId: 'feishu', accountId, secret: 'fixture-secret' }))
        .rejects.toThrow(new RegExp(`^${code}$`, 'u'))
    }
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('reports permission denial from the actual SDK HTTP failure without forwarding private Axios fields', async () => {
    vi.spyOn(defaultHttpInstance, 'post').mockResolvedValue({
      code: 0,
      tenant_access_token: 'fixture-token',
      expire: 7200,
    })
    vi.spyOn(defaultHttpInstance, 'request').mockRejectedValue({
      response: { status: 400, data: { code: 99991672, msg: 'fixture-secret' } },
      config: { headers: { Authorization: 'Bearer fixture-token' } },
    })
    await expect(discoverChannelTenant({ adapterId: 'feishu', accountId, secret: 'fixture-secret' }))
      .rejects.toThrow(/^TENANT_DISCOVERY_PERMISSION_DENIED$/u)
  })
})
