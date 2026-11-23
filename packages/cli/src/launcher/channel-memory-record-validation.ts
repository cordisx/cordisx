export const MEMORY_KINDS = ['fact', 'preference', 'person', 'conversation', 'collaboration', 'impression'] as const
const FIELDS = [
  'kind',
  'title',
  'summary',
  'tags',
  'entityRefs',
  'evidenceType',
  'confidence',
  'expiresAt',
  'observedAt',
]
export interface MemoryValidationIssue {
  field: string
  expected: string
}
export class MemoryRecordValidationError extends Error {
  constructor(readonly issues: readonly MemoryValidationIssue[]) {
    super('MEMORY_INVALID_RECORD')
  }
  response() {
    return {
      status: 'rejected',
      code: this.message,
      retrySafe: true,
      issues: this.issues,
      guidance:
        'No memory write was attempted. Correct these fields and retry in this same authenticated turn; do not infer missing facts or broaden authorization. For a task milestone or decision use kind fact and describe its meaning in summary/tags. Read memory guide write for examples.',
    }
  }
}
const date = (value: unknown) =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value

/** Validation is read-only and never guesses evidence, identity, confidence or record kind. */
export function memoryRecordIssues(value: unknown, exact = true): MemoryValidationIssue[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [{
      field: 'record',
      expected: 'object containing kind,title,summary,tags,entityRefs,evidenceType,confidence; required record wrapper',
    }]
  }
  const input = value as Record<string, unknown>, issues: MemoryValidationIssue[] = []
  const check = (field: string, valid: boolean, expected: string) => {
    if (!valid) issues.push({ field, expected })
  }
  check(
    'kind',
    typeof input.kind === 'string' && (MEMORY_KINDS as readonly string[]).includes(input.kind),
    MEMORY_KINDS.join('|') + '; task/decision are not kinds',
  )
  check(
    'title',
    typeof input.title === 'string' && !!input.title.trim() && input.title.length <= 256,
    'nonempty string, at most 256 characters',
  )
  check(
    'summary',
    typeof input.summary === 'string' && !!input.summary.trim() && Buffer.byteLength(input.summary) <= 16384
      && !input.summary.includes('\0'),
    'nonempty string, at most 16384 UTF-8 bytes, no NUL',
  )
  check(
    'evidenceType',
    typeof input.evidenceType === 'string' && input.evidenceType.length <= 128,
    'string at most 128 characters, e.g. explicit or verified',
  )
  check(
    'confidence',
    typeof input.confidence === 'number' && Number.isFinite(input.confidence) && input.confidence >= 0
      && input.confidence <= 1,
    'finite JSON number between 0 and 1, not a string',
  )
  for (const field of ['tags', 'entityRefs']) {
    check(
      field,
      Array.isArray(input[field]) && input[field].length <= 32
        && input[field].every(v => typeof v === 'string' && v.length <= 128),
      'array of at most 32 strings, each at most 128 characters; [] allowed',
    )
  }
  for (const field of ['expiresAt', 'observedAt']) {
    if (input[field] !== undefined) {
      check(field, date(input[field]), 'UTC ISO timestamp including milliseconds, e.g. 2026-01-01T00:00:00.000Z')
    }
  }
  if (input.kind === 'impression') {
    check('observedAt', date(input.observedAt), 'required UTC ISO timestamp for impression')
  }
  if (exact) {
    for (const field of Object.keys(input)) {
      if (!FIELDS.includes(field)) {
        issues.push({ field, expected: 'not an accepted record field; provenance, owner and scope are Host-assigned' })
      }
    }
  }
  return issues
}
export function validateMemoryRecord(value: unknown, exact = true): void {
  const issues = memoryRecordIssues(value, exact)
  if (issues.length) throw new MemoryRecordValidationError(issues)
}
