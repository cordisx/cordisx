import { type ChannelMediaPrepareInput, validateChannelMediaPrepareInput } from './channel-send-payload.js'

export const CHANNEL_MEDIA_CHUNK_BYTES = 65_536
export const CHANNEL_MEDIA_RPC_BYTES = 262_144

export type ChannelMediaPrepareRequest =
  | (Omit<ChannelMediaPrepareInput, 'bytesBase64'> & {
    readonly action: 'begin'
    readonly size: number
    readonly sha256: string
  })
  | { readonly action: 'chunk'; readonly uploadId: string; readonly offset: number; readonly bytesBase64: string }
  | { readonly action: 'commit'; readonly uploadId: string }

export function validateChannelMediaPrepareRequest(value: unknown): ChannelMediaPrepareRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CHANNEL_PAYLOAD')
  const input = value as Record<string, unknown>
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') >= CHANNEL_MEDIA_RPC_BYTES - 4096) {
    throw new Error('CHANNEL_RPC_INPUT_TOO_LARGE')
  }
  if (input.action === 'begin') {
    if (
      Object.keys(input).some(key =>
        ![
          'action',
          'account',
          'target',
          'operationId',
          'type',
          'format',
          'mediaType',
          'filename',
          'name',
          'durationMs',
          'size',
          'sha256',
        ].includes(key)
      )
    ) {
      throw new Error('INVALID_CHANNEL_PAYLOAD')
    }
    const { action, size, sha256, ...metadata } = input
    validateChannelMediaPrepareInput({ ...metadata, bytesBase64: 'YQ==' })
    if (
      !Number.isSafeInteger(size) || Number(size) <= 0 || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)
    ) {
      throw new Error('INVALID_CHANNEL_PAYLOAD')
    }
    return input as unknown as ChannelMediaPrepareRequest
  }
  const allowed = input.action === 'chunk' ? ['action', 'uploadId', 'offset', 'bytesBase64'] : ['action', 'uploadId']
  if (
    !['chunk', 'commit'].includes(String(input.action)) || Object.keys(input).some(key => !allowed.includes(key))
    || typeof input.uploadId !== 'string' || !/^upload:[A-Za-z0-9_-]{1,128}$/u.test(input.uploadId)
  ) throw new Error('INVALID_CHANNEL_PAYLOAD')
  if (input.action === 'chunk') {
    if (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0) throw new Error('INVALID_CHANNEL_PAYLOAD')
    validateChannelMediaPrepareInput({
      account: { adapterId: 'validation', accountId: 'validation', tenantId: 'validation' },
      target: { id: 'validation', kind: 'direct' },
      operationId: 'validation',
      type: 'file',
      format: 'binary',
      filename: 'chunk.bin',
      mediaType: 'application/octet-stream',
      bytesBase64: input.bytesBase64,
    })
  }
  return input as unknown as ChannelMediaPrepareRequest
}

export function parseChannelMediaPrepareArgv(args: readonly string[]): {
  readonly input: ChannelMediaPrepareRequest
  readonly profile?: string
  readonly context?: string
} {
  const action = args[0], options: Record<string, string> = {}
  if (!action || !['begin', 'chunk', 'commit'].includes(action)) throw new Error('INVALID_CHANNEL_OPTIONS')
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1]
    if (
      !key || !['--input', '--profile', '--context'].includes(key) || value === undefined || Object.hasOwn(options, key)
    ) {
      throw new Error('INVALID_CHANNEL_OPTIONS')
    }
    options[key] = value
  }
  const source = options['--input']
  if (!source) throw new Error('INVALID_CHANNEL_INPUT')
  if (Buffer.byteLength(source, 'utf8') >= CHANNEL_MEDIA_RPC_BYTES - 4096) {
    throw new Error('CHANNEL_RPC_INPUT_TOO_LARGE')
  }
  let input: unknown
  try {
    input = JSON.parse(source)
  } catch {
    throw new Error('INVALID_CHANNEL_INPUT')
  }
  if (!input || typeof input !== 'object' || Array.isArray(input) || 'action' in input) {
    throw new Error('INVALID_CHANNEL_PAYLOAD')
  }
  return {
    input: validateChannelMediaPrepareRequest({ ...input, action }),
    ...(options['--profile'] === undefined ? {} : { profile: options['--profile'] }),
    ...(options['--context'] === undefined ? {} : { context: options['--context'] }),
  }
}
