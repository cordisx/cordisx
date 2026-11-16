import type { ChannelCredentialRef } from '../launcher/channel-credential-drafts.js'
import type { HostDraftFieldDefinition } from './host-ui/HostDraftFields.js'

export interface ChannelCredentialValues {
  appId: string
  tenantId: string
  secret: string
}

export function channelCredentialFields(input: {
  readonly account?: ChannelCredentialRef
  readonly values: ChannelCredentialValues
  readonly zh: boolean
  readonly busy?: boolean
  readonly optionalSecret?: boolean
  readonly change: (id: keyof ChannelCredentialValues, value: string) => void
}): HostDraftFieldDefinition[] {
  return (['appId', 'tenantId', 'secret'] as const).map(id => ({
    id: `channel-${id}`,
    controlId: `channel-credential-${id}`,
    initialValue: id === 'secret' ? '' : input.account?.[id === 'appId' ? 'accountId' : 'tenantId'] ?? input.values[id],
    fieldActions: 'static',
    ...(id === 'secret' ? { transientSecret: true } : {}),
    field: {
      namespace: 'channel',
      path: [id],
      type: 'string',
      value: id === 'secret' ? '' : input.values[id],
      role: id === 'secret' ? 'password' : 'text',
      label: id === 'appId'
        ? 'App ID'
        : id === 'secret'
        ? 'App Secret (App Key)'
        : input.zh
        ? '租户 ID（留空自动查询）'
        : 'Tenant ID (optional; detected automatically)',
      required: id !== 'tenantId' && !(id === 'secret' && input.optionalSecret),
      ...(id === 'secret' && input.optionalSecret
        ? { description: input.zh ? '留空保留当前密钥' : 'Leave blank to keep the current secret' }
        : {}),
      disabled: input.busy === true || input.account !== undefined && id !== 'secret',
    },
    onChange: value => input.change(id, typeof value === 'string' ? value : ''),
  }))
}

export function validateChannelCredentialValues(values: ChannelCredentialValues, zh: boolean): Map<string, string> {
  const errors = new Map<string, string>()
  for (const id of ['appId', 'tenantId', 'secret'] as const) {
    const value = values[id]
    if (
      (id !== 'tenantId' && !value.trim()) || value.length > (id === 'secret' ? 16384 : 512)
      || /[\u0000-\u001f]/u.test(value) || id === 'appId' && !/^cli_[A-Za-z0-9_]+$/u.test(value)
    ) {
      errors.set(`channel-${id}`, zh ? '请检查此项' : 'Please check this value')
    }
  }
  return errors
}

export function channelCredentialFailure(code: string | undefined, zh: boolean): { id: string; message: string } {
  const tenant = code === 'TENANT_DISCOVERY_PERMISSION_DENIED' || code === 'TENANT_DISCOVERY_FAILED'
  return {
    id: tenant ? 'channel-tenantId' : 'channel-secret',
    message: code === 'TENANT_DISCOVERY_PERMISSION_DENIED'
      ? zh
        ? '自动查询需要开通并发布 tenant:tenant:readonly 权限，也可手动填写租户 ID。'
        : 'Automatic lookup needs the published tenant:tenant:readonly scope. You can also enter the Tenant ID.'
      : code === 'TENANT_DISCOVERY_FAILED'
      ? zh
        ? '租户 ID 查询失败，请检查网络与应用配置，或手动填写租户 ID。'
        : 'Tenant lookup failed. Check the network and application settings, or enter the Tenant ID.'
      : zh
      ? '凭据未保存，请检查后重试'
      : 'Credentials were not saved. Please try again',
  }
}
