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
        ? '租户 ID（留空尝试自动查询）'
        : 'Tenant ID (leave blank to try automatic lookup)',
      required: id !== 'tenantId' && !(id === 'secret' && input.optionalSecret),
      ...(id === 'tenantId' && (input.account === undefined || !input.account.tenantId)
        ? {
          description: input.zh
            ? '填写应用所属企业的 tenant_key（例如该应用可信事件的 header.tenant_key），不是 App ID。留空时需要应用已开通并发布 tenant:tenant:readonly；在开放平台的应用「权限管理」中申请，发布并等待审核后重试。'
            : 'Enter the application tenant’s tenant_key (for example, header.tenant_key in a trusted event for this app), not its App ID. Automatic lookup requires tenant:tenant:readonly: request it in the application’s Permissions page, publish the change, wait for approval, and retry.',
        }
        : {}),
      ...(id === 'secret' && input.optionalSecret
        ? { description: input.zh ? '留空保留当前密钥' : 'Leave blank to keep the current secret' }
        : {}),
      disabled: input.busy === true || input.account !== undefined && id !== 'secret'
          && !(id === 'tenantId' && !input.account.tenantId),
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
    || code === 'TENANT_MISMATCH'
  return {
    id: tenant ? 'channel-tenantId' : 'channel-secret',
    message: code === 'TENANT_MISMATCH'
      ? zh
        ? '填写的租户 ID 与应用所属企业不一致，请核对 tenant_key，或留空以自动查询。'
        : 'The tenant ID does not match the application’s tenant. Check its tenant_key or leave the field blank for automatic lookup.'
      : code === 'TENANT_DISCOVERY_PERMISSION_DENIED'
      ? zh
        ? '自动查询需要开通并发布 tenant:tenant:readonly 权限，也可手动填写租户 ID。'
        : 'Automatic lookup needs the published tenant:tenant:readonly scope. You can also enter the Tenant ID.'
      : code === 'TENANT_DISCOVERY_FAILED'
      ? zh
        ? '租户 ID 查询失败，请检查网络与应用配置，或手动填写租户 ID。'
        : 'Tenant lookup failed. Check the network and application settings, or enter the Tenant ID.'
      : code === 'CREDENTIAL_VALIDATION_FAILED'
      ? zh
        ? '应用凭据验证失败，请检查 App ID、App Secret 和网络后重试。'
        : 'Application credential validation failed. Check the App ID, App Secret, and network, then retry.'
      : zh
      ? '凭据未保存，请检查后重试'
      : 'Credentials were not saved. Please try again',
  }
}
