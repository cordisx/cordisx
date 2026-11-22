import { readFile } from 'node:fs/promises'
import path from 'node:path'

export interface ChannelFeedbackSettings {
  reaction: { enabled: boolean; emojiType: string; completionEmojiType?: string }
  wait: { enabled: boolean; delaySeconds: number; text: string; texts?: readonly string[] }
}
export const DEFAULT_CHANNEL_FEEDBACK: ChannelFeedbackSettings = {
  reaction: { enabled: true, emojiType: 'OnIt' },
  wait: { enabled: true, delaySeconds: 30, text: '已收到，正在处理，请稍候。' },
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_FEEDBACK_CONFIG')
  return value as Record<string, unknown>
}
const text = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= 1000 && !value.includes('\0')
export function parseChannelFeedbackSettings(value: unknown): ChannelFeedbackSettings {
  const row = object(value), reaction = object(row.reaction ?? {}), wait = object(row.wait ?? {})
  if (
    Object.keys(row).some(key => !['reaction', 'wait'].includes(key))
    || Object.keys(reaction).some(key => !['enabled', 'emojiType', 'completionEmojiType'].includes(key))
    || Object.keys(wait).some(key => !['enabled', 'delaySeconds', 'text', 'texts'].includes(key))
  ) throw new Error('INVALID_FEEDBACK_CONFIG')
  const result = {
    reaction: { ...DEFAULT_CHANNEL_FEEDBACK.reaction, ...reaction },
    wait: { ...DEFAULT_CHANNEL_FEEDBACK.wait, ...wait },
  }
  if (
    typeof result.reaction.enabled !== 'boolean' || typeof result.reaction.emojiType !== 'string'
    || !/^[A-Za-z0-9_]{1,64}$/u.test(result.reaction.emojiType)
    || result.reaction.completionEmojiType !== undefined
      && (typeof result.reaction.completionEmojiType !== 'string'
        || !/^[A-Za-z0-9_]{1,64}$/u.test(result.reaction.completionEmojiType))
    || typeof result.wait.enabled !== 'boolean' || !Number.isSafeInteger(result.wait.delaySeconds)
    || result.wait.delaySeconds < 1 || result.wait.delaySeconds > 86400 || !text(result.wait.text)
    || result.wait.texts !== undefined && (!Array.isArray(result.wait.texts) || result.wait.texts.length < 1
        || result.wait.texts.length > 50 || !result.wait.texts.every(text))
  ) throw new Error('INVALID_FEEDBACK_CONFIG')
  return result as ChannelFeedbackSettings
}
/** Profile-local configuration; root file is the legacy deployment-compatible fallback. */
export async function readChannelFeedbackSettings(
  directory: string,
  legacyDirectory?: string,
): Promise<ChannelFeedbackSettings> {
  for (const root of [...new Set([directory, legacyDirectory].filter((value): value is string => !!value))]) {
    try {
      return parseChannelFeedbackSettings(JSON.parse(await readFile(path.join(root, 'channel-feedback.json'), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error('INVALID_FEEDBACK_CONFIG')
    }
  }
  return structuredClone(DEFAULT_CHANNEL_FEEDBACK)
}
