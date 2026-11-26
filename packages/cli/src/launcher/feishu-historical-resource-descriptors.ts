export interface FeishuHistoricalResourceDescriptor {
  readonly type: 'image' | 'file' | 'audio' | 'video'
  readonly fileKey: string
  readonly fileName?: string
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('HISTORICAL_RESOURCE_INVALID_MESSAGE')
  }
  return value as Record<string, unknown>
}

export function feishuHistoricalResourceDescriptors(
  value: unknown,
  conversationId: string,
  messageId: string,
): readonly FeishuHistoricalResourceDescriptor[] {
  const message = object(value)
  if (message.message_id !== messageId || message.chat_id !== conversationId || message.deleted) {
    throw new Error('HISTORICAL_RESOURCE_SOURCE_MISMATCH')
  }
  if (!['image', 'post', 'audio', 'file', 'media', 'video'].includes(String(message.msg_type))) {
    throw new Error('HISTORICAL_RESOURCE_UNSUPPORTED')
  }
  const body = object(message.body)
  if (typeof body.content !== 'string' || Buffer.byteLength(body.content, 'utf8') > 90_000) {
    throw new Error('HISTORICAL_RESOURCE_INVALID_MESSAGE')
  }
  let content: Record<string, unknown>
  try {
    content = object(JSON.parse(body.content))
  } catch {
    throw new Error('HISTORICAL_RESOURCE_INVALID_MESSAGE')
  }
  const resources: FeishuHistoricalResourceDescriptor[] = []
  const seen = new Map<string, FeishuHistoricalResourceDescriptor['type']>()
  const add = (type: FeishuHistoricalResourceDescriptor['type'], fileKey: unknown, fileName?: unknown) => {
    if (typeof fileKey !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/u.test(fileKey)) {
      throw new Error('HISTORICAL_RESOURCE_INVALID_MESSAGE')
    }
    if (seen.has(fileKey)) {
      if (seen.get(fileKey) !== type) throw new Error('HISTORICAL_RESOURCE_INVALID_MESSAGE')
      return
    }
    if (resources.length >= 16) throw new Error('HISTORICAL_RESOURCE_LIMIT')
    seen.set(fileKey, type)
    resources.push({ type, fileKey, ...(typeof fileName === 'string' ? { fileName } : {}) })
  }
  if (message.msg_type === 'image') add('image', content.image_key)
  else if (message.msg_type !== 'post') {
    add(
      message.msg_type === 'audio' ? 'audio' : message.msg_type === 'file' ? 'file' : 'video',
      content.file_key,
      content.file_name,
    )
    if (content.image_key !== undefined) add('image', content.image_key)
  } else {
    let visited = 0
    const visit = (node: unknown, depth: number) => {
      if (++visited > 1000 || depth > 12) throw new Error('HISTORICAL_RESOURCE_LIMIT')
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const child of node) visit(child, depth + 1)
        return
      }
      const item = object(node)
      if (item.tag === 'img') {
        add('image', item.image_key ?? item.img_key)
        return
      }
      for (const child of Object.values(item)) visit(child, depth + 1)
    }
    visit(content, 0)
  }
  if (!resources.length) throw new Error('HISTORICAL_RESOURCE_NOT_FOUND')
  return resources
}
