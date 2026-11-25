import { readFile } from 'node:fs/promises'
import path from 'node:path'

export interface ChannelUserMemorySettings {
  enabled: boolean
  remember: boolean
  recall: boolean
  groupRecall: boolean
  timeoutMs: number
  providerId?: string
  model?: string
}
export async function channelUserMemorySettings(directory: string): Promise<ChannelUserMemorySettings> {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(await readFile(path.join(directory, 'channel-user-memory.json'), 'utf8')) as Record<
      string,
      unknown
    >
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('CHANNEL_USER_MEMORY_CONFIG_INVALID')
    raw = {}
  }
  if (
    !raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.entries(raw).some(([key, value]) =>
      ['enabled', 'remember', 'recall', 'groupRecall'].includes(key)
        ? typeof value !== 'boolean'
        : ['providerId', 'model'].includes(key)
        ? typeof value !== 'string' || !value.trim() || value.length > 512
        : key === 'timeoutMs'
        ? !Number.isSafeInteger(value) || Number(value) < 100 || Number(value) > 10000
        : true
    )
    || (raw.providerId === undefined) !== (raw.model === undefined)
  ) throw new Error('CHANNEL_USER_MEMORY_CONFIG_INVALID')
  return {
    enabled: true,
    remember: true,
    recall: true,
    groupRecall: true,
    timeoutMs: 5000,
    ...raw,
  } as ChannelUserMemorySettings
}
