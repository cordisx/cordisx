import { createHmac } from 'node:crypto'
import { redactDiagnosticAuthorityAndPaths } from '../launcher/diagnostic-redaction.js'

export interface RedactionResult {
  readonly text: string
  readonly counts: Readonly<Record<string, number>>
}

function tally(counts: Record<string, number>, category: string, amount: number): void {
  if (amount > 0) counts[category] = (counts[category] ?? 0) + amount
}

function replace(
  input: string,
  expression: RegExp,
  replacement: string,
  category: string,
  counts: Record<string, number>,
): string {
  return input.replace(expression, (...args: unknown[]) => {
    tally(counts, category, 1)
    return replacement
  })
}

/** Central feedback-only sanitizer. It deliberately drops authority before location normalization. */
export function redactFeedbackText(input: string, roots: readonly string[] = []): RedactionResult {
  const counts: Record<string, number> = Object.create(null) as Record<string, number>
  let text = input.split(/\r?\n/u).map(line => {
    if (
      /\b(?:prompt|message(?:_body)?|conversation|tool[_ -]?(?:input|output|result)|session[_ -]?id)\b/iu.test(line)
    ) {
      tally(counts, 'content', 1)
      return '[REDACTED_CONTENT]'
    }
    return line
  }).join('\n')
  text = replace(
    text,
    /\b(?:authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/giu,
    '[REDACTED_SECRET]',
    'secret',
    counts,
  )
  text = replace(
    text,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bootstrap[_-]?token|instance[_-]?token|password|credential)\s*[:=]\s*[^\s,;]+/giu,
    '[REDACTED_SECRET]',
    'secret',
    counts,
  )
  text = replace(text, /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/gu, 'Bearer [REDACTED_SECRET]', 'secret', counts)
  text = replace(text, /https?:\/\/[^\s'"<>]+/gu, '[REDACTED_URL]', 'url', counts)
  for (const root of roots.filter(root => root.length > 1).sort((left, right) => right.length - left.length)) {
    text = replace(text, new RegExp(`${escapeRegExp(root)}[^\\s'"<>]*`, 'gu'), '[REDACTED_PATH]', 'path', counts)
  }
  text = replace(
    text,
    /(?:[A-Za-z]:[\\/][^\s'"<>]+|\/(?:Users|home|private|tmp|var|opt|Applications)\/[^\s'"<>]+)/gu,
    '[REDACTED_PATH]',
    'path',
    counts,
  )
  text = replace(text, /\b[A-Za-z0-9_-]{40,}\b/gu, '[REDACTED_OPAQUE]', 'opaque', counts)
  text = redactDiagnosticAuthorityAndPaths(text)
  return { text, counts }
}

export function feedbackReference(key: Buffer, prefix: string, value: string): string {
  return `${prefix}_${createHmac('sha256', key).update(value).digest('hex').slice(0, 32)}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
