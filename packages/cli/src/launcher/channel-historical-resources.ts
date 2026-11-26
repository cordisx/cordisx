import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import type { ChannelHistoricalResourceResultV1 } from '@cordisx/protocol/channel-historical-resources/v1'
import { ChannelInboundResources } from './channel-inbound-resources.js'
import { feishuHistoricalResourceDescriptors } from './feishu-historical-resource-descriptors.js'

async function historicalResourceSdkRead<Result>(operation: () => Promise<Result>): Promise<Result | undefined> {
  try {
    return await operation()
  } catch {
    return undefined
  }
}

export class ChannelHistoricalResources {
  private readonly owner = randomUUID()
  private readonly resources = new ChannelInboundResources()
  private readonly active = new Map<object, number>()
  private disposed = false

  async read(
    event: ChannelEventRef,
    messageId: string,
    index: number,
    prepare: boolean,
    caller: string,
    channel: Partial<Pick<LarkChannel, 'rawClient'>> | undefined,
    authorize: () => void,
    range?: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<ChannelHistoricalResourceResultV1> {
    if (!/^om_[A-Za-z0-9_]{1,200}$/u.test(messageId) || !Number.isInteger(index) || index < 0 || index > 15) {
      throw new Error('INVALID_REQUEST')
    }
    const client = channel?.rawClient
    if (!client || this.disposed) return { status: 'unavailable', code: 'HISTORICAL_RESOURCE_UNAVAILABLE' }
    if ((this.active.get(client) ?? 0) >= 4) return { status: 'unavailable', code: 'HISTORICAL_RESOURCE_BUSY' }
    let expired = false
    let download: Readable | undefined
    const check = () => {
      if (expired || signal?.aborted) throw new Error('HISTORICAL_RESOURCE_TIMEOUT')
      if (this.disposed) throw new Error('CHANNEL_GENERATION_CHANGED')
      authorize()
    }
    check()
    const cancel = () => {
      expired = true
      download?.destroy()
    }
    signal?.addEventListener('abort', cancel, { once: true })
    this.active.set(client, (this.active.get(client) ?? 0) + 1)
    let timer: ReturnType<typeof setTimeout> | undefined
    const operation = (async () => {
      const response = await historicalResourceSdkRead(() =>
        client.im.v1.message.get({ path: { message_id: messageId } })
      )
      check()
      if (!response) return { status: 'unavailable' as const, code: 'HISTORICAL_RESOURCE_READ_FAILED' }
      if (response.code !== 0) throw new Error('HISTORICAL_RESOURCE_READ_FAILED')
      if (response.data?.items?.length !== 1) throw new Error('HISTORICAL_RESOURCE_INVALID_MESSAGE')
      const item = response.data.items[0]
      const descriptors = feishuHistoricalResourceDescriptors(item, event.conversationId, messageId)
      const descriptor = descriptors[index]
      if (!descriptor) throw new Error('HISTORICAL_RESOURCE_NOT_FOUND')
      const owned: ChannelEventRef = {
        adapterId: event.adapterId,
        accountId: event.accountId,
        tenantId: event.tenantId,
        conversationId: event.conversationId,
        kind: event.kind,
        threadId: messageId,
        semantics: 'conversation',
        eventId: `resource:${this.owner}:${caller}`,
        messageId,
        ...(event.actor ? { actor: event.actor } : {}),
      }
      const key = `${messageId}:${descriptor.fileKey}`
      if (prepare) {
        const cached = await this.resources.inspect(owned, key)
        if (cached.state !== 'ready') {
          check()
          const resource = await historicalResourceSdkRead(() =>
            client.im.v1.messageResource.get({
              path: { message_id: messageId, file_key: descriptor.fileKey },
              params: { type: descriptor.type === 'image' ? 'image' : 'file' },
            })
          )
          if (!resource) {
            check()
            return { status: 'unavailable' as const, code: 'HISTORICAL_RESOURCE_READ_FAILED' }
          }
          const stream = resource.getReadableStream()
          download = stream
          try {
            check()
          } catch (error) {
            stream.destroy()
            throw error
          }
          try {
            await this.resources.ingest(owned, stream, descriptor.type, descriptor.fileName, key)
          } catch (error) {
            check()
            throw error
          }
        }
      }
      check()
      if (range) {
        const bytes = await this.resources.readRange(owned, key, range.offset, range.length)
        check()
        const status = await this.resources.inspect(owned, key)
        check()
        if (status.state !== 'ready') throw new Error('RESOURCE_NOT_READY')
        return {
          status: 'ok' as const,
          messageId,
          index,
          type: descriptor.type,
          resource: status,
          chunk: {
            offset: range.offset,
            base64: bytes.toString('base64'),
            nextOffset: range.offset + bytes.length,
            hasMore: range.offset + bytes.length < status.attachment.size,
          },
        }
      }
      const resource = await this.resources.inspect(owned, key)
      check()
      return {
        status: 'ok' as const,
        messageId,
        index,
        type: descriptor.type,
        resource,
      }
    })().finally(() => {
      signal?.removeEventListener('abort', cancel)
      this.active.set(client, Math.max(0, (this.active.get(client) ?? 1) - 1))
    })
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            expired = true
            download?.destroy()
            reject(new Error('HISTORICAL_RESOURCE_TIMEOUT'))
          }, 2500)
        }),
      ])
    } catch (error) {
      if (
        error instanceof Error && /^(?:CHANNEL_|HISTORICAL_RESOURCE_|RESOURCE_)[A-Z0-9_]{1,100}$/u.test(error.message)
      ) {
        throw error
      }
      return { status: 'unavailable', code: 'HISTORICAL_RESOURCE_READ_FAILED' }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async dispose() {
    this.disposed = true
    await this.resources.dispose()
  }
}
