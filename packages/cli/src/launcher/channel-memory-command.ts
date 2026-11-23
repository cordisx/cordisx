import type { ChannelAgentAccess } from './channel-agent-access.js'
import type { MemoryAuthority, MemoryGrant } from './channel-memory-policy.js'
import { ChannelMemoryStore, type MemoryInput } from './channel-memory-store.js'
import { channelMemoryGuide } from './channel-memory-guide.js'
import { ownMemoryTopic } from './channel-memory-intent.js'
import type { ChannelMemoryAuthority } from './channel-memory-authority.js'
import { memoryKey } from './channel-memory-policy.js'
import { MemoryRecordValidationError, validateMemoryRecord } from './channel-memory-record-validation.js'

export async function channelMemoryCommand(
  store: ChannelMemoryStore,
  access: ChannelAgentAccess,
  value: Record<string, unknown>,
  metadata: unknown,
  authorization?: ChannelMemoryAuthority,
): Promise<unknown> {
  const caller = access.caller(metadata)
  if (!caller?.source.actor?.userId || access.preparation(metadata)) {
    throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
  }
  const source = caller.source
  if (source.kind !== 'direct' && source.kind !== 'group' || !source.messageId) {
    throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
  }
  const ownTopic = ownMemoryTopic(access.requestText(metadata))
  const authority: MemoryAuthority = {
    actor: {
      adapterId: source.adapterId,
      accountId: source.accountId,
      tenantId: source.tenantId,
      userId: source.actor!.userId,
    },
    conversation: {
      adapterId: source.adapterId,
      accountId: source.accountId,
      tenantId: source.tenantId,
      conversationId: source.conversationId,
    },
    kind: source.kind,
    ...(ownTopic ? { ownTopic } : {}),
  }
  const allowed: Record<string, string[]> = {
    guide: ['topic'],
    remember: ['record'],
    get: ['id'],
    search: ['query', 'entity'],
    navigate: ['cursor', 'limit', 'maxBytes'],
    'search-page': ['query', 'entity', 'cursor', 'limit', 'maxBytes'],
    batch: ['ids', 'maxBytes'],
    update: ['id', 'revision', 'record'],
    forget: ['id', 'revision'],
    index: [],
    grant: ['grant'],
    revoke: ['id'],
    'grant-list': [],
    'identity-unbind': [],
    'identity-challenge': ['target'],
    'identity-confirm': ['challenge'],
  }
  if (authorization) authority.administer = await authorization.scopes(authority.actor)
  const action = String(value.action)
  if ((action === 'remember' || action === 'update') && value.record === undefined) {
    throw new MemoryRecordValidationError([{
      field: 'record',
      expected: 'required object wrapper; remember {record:{...}} or update {id,revision,record:{...}}',
    }])
  }
  if (
    !allowed[action] || Object.keys(value).some(key => key !== 'action' && !allowed[action]!.includes(key))
  ) {
    throw new Error('MEMORY_INVALID_REQUEST')
  }
  let result: unknown
  if (action === 'guide') result = channelMemoryGuide(value.topic as string | undefined)
  else if (action === 'remember') {
    result = await store.remember(authority, value.record as MemoryInput, source.messageId)
  } else if (action === 'get') result = await store.get(authority, String(value.id))
  else if (action === 'navigate' || action === 'search-page') {
    const options = { ...value }
    delete options.action
    result = await store.browse(authority, { ...options, navigation: action === 'navigate' })
  } else if (action === 'batch') {
    result = await store.batch(authority, value.ids as string[], value.maxBytes as number | undefined)
  } else if (action === 'search') {
    result = await store.search(authority, value.query as string, value.entity as string | undefined)
  } else if (action === 'update' || action === 'forget') {
    if (action === 'update') validateMemoryRecord(value.record)
    result = await store.change(
      authority,
      String(value.id),
      value.revision as number,
      action === 'update' ? value.record as MemoryInput : undefined,
    )
  } else if (action === 'index') result = await store.index(authority)
  else if (action === 'grant') {
    const grant = value.grant as MemoryGrant
    if (!grant?.target) throw new Error('MEMORY_INVALID_GRANT')
    if (!/share|grant|connect|分享|共享|授权|打通/iu.test(access.requestText(metadata) ?? '')) {
      throw new Error('MEMORY_GRANT_CONSENT_REQUIRED')
    }
    const sourceScope = !grant.source
      ? memoryKey(authority.conversation)
      : /^[a-f0-9]{64}$/u.test(grant.source)
      ? grant.source
      : memoryKey({ ...authority.conversation, conversationId: grant.source })
    const target = grant.target.kind === 'conversation' && !/^[a-f0-9]{64}$/u.test(grant.target.id)
      ? { ...grant.target, id: memoryKey({ ...authority.conversation, conversationId: grant.target.id }) }
      : grant.target
    result = await store.grant(authority, { ...grant, source: sourceScope, target })
    return {
      status: 'ok',
      result,
      audienceWarning:
        'Retained source memory is now available to this destination, including future members when it is a group.',
    }
  } else if (action === 'revoke') {
    if (!/revoke|stop.*shar|撤销|取消.*共享/iu.test(access.requestText(metadata) ?? '')) {
      throw new Error('MEMORY_GRANT_CONSENT_REQUIRED')
    }
    await store.revoke(authority, String(value.id))
    result = null
  } else if (action === 'identity-unbind') {
    await store.unbind(authority)
    result = null
  } else if (action === 'identity-challenge') {
    if (!/link|bind|绑定|关联/iu.test(access.requestText(metadata) ?? '')) {
      throw new Error('MEMORY_BINDING_CONSENT_REQUIRED')
    }
    result = await store.challenge(authority, value.target as never)
  } else if (action === 'identity-confirm') {
    const challenge = String(value.challenge)
    if (!(access.requestText(metadata) ?? '').includes(challenge)) throw new Error('MEMORY_BINDING_CONSENT_REQUIRED')
    result = await store.confirm(authority, challenge)
  } else if (action === 'grant-list') result = await store.grants(authority)
  else throw new Error('MEMORY_INVALID_REQUEST')
  return { status: 'ok', result }
}
