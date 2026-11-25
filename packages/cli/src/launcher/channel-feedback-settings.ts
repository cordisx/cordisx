import { readFile } from 'node:fs/promises'
import path from 'node:path'

export interface ChannelFeedbackSettings {
  reaction: {
    enabled: boolean
    emojiType: string
    receivedEnabled?: boolean
    receivedEmojiType?: string
    processingEnabled?: boolean
    completionEmojiType?: string
    stoppedEnabled?: boolean
    stoppedEmojiType?: string
  }
  wait: {
    enabled: boolean
    delaySeconds: number
    text: string
    texts?: readonly string[]
    mode?: 'agent' | 'fixed'
    quietSeconds?: number
    repeatSeconds?: number
    finishSeconds?: number
    ackTimeoutSeconds?: number
  }
}
export const DEFAULT_CHANNEL_FEEDBACK: ChannelFeedbackSettings = {
  reaction: {
    enabled: true,
    emojiType: 'OnIt',
    receivedEnabled: true,
    receivedEmojiType: 'Get',
    processingEnabled: true,
    stoppedEnabled: true,
    stoppedEmojiType: 'DONE',
  },
  wait: {
    enabled: true,
    mode: 'agent',
    quietSeconds: 5,
    repeatSeconds: 30,
    finishSeconds: 10,
    ackTimeoutSeconds: 60,
    delaySeconds: 30,
    text: '已收到，正在处理，请稍候。',
  },
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
    || Object.keys(reaction).some(key =>
      ![
        'enabled',
        'emojiType',
        'completionEmojiType',
        'receivedEnabled',
        'receivedEmojiType',
        'processingEnabled',
        'stoppedEnabled',
        'stoppedEmojiType',
      ]
        .includes(key)
    )
    || Object.keys(wait).some(key =>
      ![
        'enabled',
        'delaySeconds',
        'text',
        'texts',
        'mode',
        'quietSeconds',
        'repeatSeconds',
        'finishSeconds',
        'ackTimeoutSeconds',
      ].includes(
        key,
      )
    )
  ) throw new Error('INVALID_FEEDBACK_CONFIG')
  const result = {
    reaction: {
      ...DEFAULT_CHANNEL_FEEDBACK.reaction,
      ...reaction,
      receivedEnabled: reaction.receivedEnabled === undefined
        ? reaction.enabled ?? DEFAULT_CHANNEL_FEEDBACK.reaction.enabled
        : reaction.receivedEnabled,
      processingEnabled: reaction.processingEnabled === undefined
        ? reaction.enabled ?? DEFAULT_CHANNEL_FEEDBACK.reaction.enabled
        : reaction.processingEnabled,
      stoppedEnabled: reaction.stoppedEnabled === undefined
        ? (reaction.completionEmojiType === undefined
          ? reaction.enabled ?? DEFAULT_CHANNEL_FEEDBACK.reaction.stoppedEnabled
          : false)
        : reaction.stoppedEnabled,
    },
    wait: {
      ...DEFAULT_CHANNEL_FEEDBACK.wait,
      ...wait,
      mode: wait.mode ?? (['delaySeconds', 'text', 'texts'].some(key => key in wait) ? 'fixed' : 'agent'),
    },
  }
  if (
    typeof result.reaction.enabled !== 'boolean' || typeof result.reaction.emojiType !== 'string'
    || !/^[A-Za-z0-9_]{1,64}$/u.test(result.reaction.emojiType)
    || typeof result.reaction.receivedEnabled !== 'boolean' || typeof result.reaction.processingEnabled !== 'boolean'
    || typeof result.reaction.receivedEmojiType !== 'string'
    || !/^[A-Za-z0-9_]{1,64}$/u.test(result.reaction.receivedEmojiType)
    || typeof result.reaction.stoppedEnabled !== 'boolean'
    || typeof result.reaction.stoppedEmojiType !== 'string'
    || !/^[A-Za-z0-9_]{1,64}$/u.test(result.reaction.stoppedEmojiType)
    || result.reaction.completionEmojiType !== undefined
      && (typeof result.reaction.completionEmojiType !== 'string'
        || !/^[A-Za-z0-9_]{1,64}$/u.test(result.reaction.completionEmojiType))
    || typeof result.wait.enabled !== 'boolean' || !Number.isSafeInteger(result.wait.delaySeconds)
    || !['agent', 'fixed'].includes(String(result.wait.mode))
    || ['quietSeconds', 'repeatSeconds', 'finishSeconds'].some(key =>
      !Number.isSafeInteger(result.wait[key as keyof typeof result.wait])
      || Number(result.wait[key as keyof typeof result.wait]) < 1
      || Number(result.wait[key as keyof typeof result.wait]) > 86400
    )
    || !Number.isSafeInteger(result.wait.ackTimeoutSeconds) || Number(result.wait.ackTimeoutSeconds) < 0
    || Number(result.wait.ackTimeoutSeconds) > 86400
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
