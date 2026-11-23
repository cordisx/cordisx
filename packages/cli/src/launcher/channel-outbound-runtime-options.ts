import { createHash, randomUUID } from 'node:crypto'
import { validateOutboundMedia } from '@cordisx/channel-runtime'
import type { ChannelPluginIdentity, ChannelRuntimeOptions, ChannelThreadRef } from '@cordisx/channel-runtime'
import type { ChannelMediaPrepareRequestV1, ChannelPreparedMediaV1 } from '@cordisx/protocol/channel-outbound/v1'
import { ChannelOutboundRpc } from './channel-outbound-rpc.js'

function pluginScope(caller: ChannelPluginIdentity): string {
  return `plugin:${
    createHash('sha256').update(JSON.stringify([caller.source, caller.pluginId, caller.generation])).digest('hex')
  }`
}

export function channelOutboundRuntimeOptions(
  outbound: ChannelOutboundRpc,
  maximumBytes?: (target: ChannelThreadRef, caller: ChannelPluginIdentity) => Promise<number>,
): Pick<
  ChannelRuntimeOptions,
  'prepareOutbound' | 'resolveOutboundMedia' | 'outboundMediaDescriptor'
> {
  return {
    prepareOutbound: async (request: ChannelMediaPrepareRequestV1, caller) => {
      if (
        !request || typeof request !== 'object' || Array.isArray(request)
        || request.contract !== 'cordisx.channel-media-prepare/v1' || request.schemaVersion !== 1
        || Object.keys(request).some(key => !['contract', 'schemaVersion', 'type', 'target', 'input'].includes(key))
      ) {
        throw new Error('INVALID_REQUEST')
      }
      let serialized: string
      try {
        serialized = JSON.stringify(request)
      } catch {
        throw new Error('INVALID_REQUEST')
      }
      if (typeof serialized !== 'string') throw new Error('INVALID_REQUEST')
      if (Buffer.byteLength(serialized, 'utf8') > 196608) throw new Error('CHANNEL_RPC_INPUT_TOO_LARGE')
      if (!request.input || typeof request.input !== 'object' || Array.isArray(request.input)) {
        throw new Error('INVALID_REQUEST')
      }
      if (request.input.kind === 'source') throw new Error('CHANNEL_MEDIA_UNAVAILABLE')
      if (request.input.kind !== 'bytes') throw new Error('INVALID_REQUEST')
      const input = request.input
      if (
        Object.keys(input).some(key =>
          !['kind', 'bytesBase64', 'format', 'mediaType', 'filename', 'size', 'sha256', 'durationMs'].includes(key)
        )
      ) throw new Error('INVALID_REQUEST')
      const { kind: _kind, bytesBase64: _bytes, mediaType: _mediaType, ...metadata } = input
      const validated = validateOutboundMedia({ ...metadata, type: request.type, handle: 'media:validation' })
      if (validated.size > 131072) throw new Error('MEDIA_SIZE_DENIED')
      const maximum = maximumBytes ? await maximumBytes(request.target, caller) : 131072
      if (!Number.isSafeInteger(maximum) || maximum < 0 || validated.size > Math.min(131072, maximum)) {
        throw new Error('MEDIA_SIZE_DENIED')
      }
      const formats: Record<string, string> = {
        png: 'image/png',
        jpeg: 'image/jpeg',
        opus: 'audio/ogg',
        mp4: 'video/mp4',
        pdf: 'application/pdf',
        binary: 'application/octet-stream',
      }
      if (!Object.hasOwn(formats, input.format) || formats[input.format] !== input.mediaType) {
        throw new Error('INVALID_MEDIA_FORMAT')
      }
      const encoded = input.bytesBase64
      if (
        typeof encoded !== 'string' || encoded.length !== 4 * Math.ceil(validated.size / 3)
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
      ) throw new Error('MEDIA_CHUNK_INVALID')
      const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
      if (encoded.length / 4 * 3 - padding !== validated.size) throw new Error('MEDIA_INTEGRITY_INVALID')
      const bytes = Buffer.from(encoded, 'base64')
      if (
        bytes.toString('base64') !== encoded || bytes.length !== input.size
        || createHash('sha256').update(bytes).digest('hex') !== input.sha256
      ) throw new Error('MEDIA_INTEGRITY_INVALID')
      const scope = pluginScope(caller)
      const operationId = randomUUID()
      const uploadId = outbound.store.begin(scope, request.target, { ...metadata, type: request.type }, operationId)
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        outbound.store.append(scope, uploadId, offset, bytes.subarray(offset, offset + 65536).toString('base64'))
      }
      const media = outbound.store.commit(scope, uploadId)
      return {
        ...media,
        contract: 'cordisx.channel-prepared-media/v1',
        schemaVersion: 1,
        mediaType: input.mediaType,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      } as ChannelPreparedMediaV1
    },
    resolveOutboundMedia: async (handle, target, maximumBytes) => {
      try {
        return await outbound.authority.resolve(handle, target, maximumBytes)
      } catch {
        throw new Error('CHANNEL_MEDIA_UNAVAILABLE')
      }
    },
    outboundMediaDescriptor: async (caller, handle, target) => {
      try {
        return outbound.store.descriptor(
          caller.source === 'cordisx:native-channel' && caller.pluginId === 'host-channel-tools'
            ? caller.generation
            : pluginScope(caller),
          handle,
          target,
        )
      } catch {
        throw new Error('CHANNEL_MEDIA_UNAVAILABLE')
      }
    },
  }
}
