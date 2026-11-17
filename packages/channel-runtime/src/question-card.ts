import { ChannelIntegrityError } from './runtime-validation.js'

/** Launcher-private, bounded question content. Raw platform cards are never accepted. */
export interface ChannelQuestionCard {
  readonly token: string
  readonly question: string
  readonly options: readonly string[]
}

export function validateQuestionCard(value: ChannelQuestionCard): ChannelQuestionCard {
  if (
    !value || Object.keys(value).sort().join(',') !== 'options,question,token'
    || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/u.test(value.token)
    || typeof value.question !== 'string' || !value.question.trim() || value.question.length > 1000
    || /\0/u.test(value.question) || !Array.isArray(value.options)
    || value.options.length < 1 || value.options.length > 5
    || value.options.some(label =>
      typeof label !== 'string' || !label.trim() || label.length > 80 || /[\0\r\n]/u.test(label)
    )
  ) throw new ChannelIntegrityError('Invalid question card')
  return { token: value.token, question: value.question, options: [...value.options] }
}
