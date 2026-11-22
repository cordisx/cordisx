/** Native review models inherit the parent thread's provider; no cross-provider routing. */
export interface ApprovalReviewSettings {
  readonly providerId: string
  readonly catalogPath: string
  readonly defaultModel?: string
  readonly models?: Readonly<Record<string, string>>
}
export interface ApprovalReviewConfiguration {
  readonly revision: number
  readonly settings: ApprovalReviewSettings | null
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REVIEW_CONFIGURATION')
  return value as Record<string, unknown>
}
const model = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value)

export function parseApprovalReviewSettings(value: unknown): ApprovalReviewSettings {
  const row = object(value)
  if (Object.keys(row).some(key => !['providerId', 'catalogPath', 'defaultModel', 'models'].includes(key))) {
    throw new Error('INVALID_REVIEW_CONFIGURATION')
  }
  if (
    typeof row.providerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(row.providerId)
    || typeof row.catalogPath !== 'string' || !row.catalogPath.trim() || row.catalogPath.length > 4096
    || /[\x00-\x1f\x7f]/u.test(row.catalogPath) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(row.catalogPath)
    || row.defaultModel !== undefined && !model(row.defaultModel)
  ) throw new Error('INVALID_REVIEW_CONFIGURATION')
  const models = row.models === undefined ? undefined : object(row.models)
  if (
    models && (Object.keys(models).length > 512
        || Object.entries(models).some(([key, value]) => !model(key) || !model(value)))
    || row.defaultModel === undefined && (!models || Object.keys(models).length === 0)
  ) throw new Error('INVALID_REVIEW_CONFIGURATION')
  return Object.freeze({
    providerId: row.providerId,
    catalogPath: row.catalogPath,
    ...(row.defaultModel === undefined ? {} : { defaultModel: row.defaultModel }),
    ...(models === undefined ? {} : { models: Object.freeze({ ...models }) as Readonly<Record<string, string>> }),
  })
}
export function parseApprovalReviewConfiguration(value: unknown): ApprovalReviewConfiguration | undefined {
  if (value === undefined) return undefined
  const row = object(value)
  if (
    Object.keys(row).some(key => !['revision', 'settings'].includes(key))
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
  ) throw new Error('INVALID_REVIEW_CONFIGURATION')
  return {
    revision: Number(row.revision),
    settings: row.settings === null ? null : parseApprovalReviewSettings(row.settings),
  }
}
