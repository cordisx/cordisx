import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ApprovalReviewSettings } from '../config/approval-review-config.js'

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
export const REVIEW_CATALOG_NATIVE_VERSIONS = ['0.149.1', '0.171.0-alpha.13'] as const

/** Preserve complete, operator-supplied native metadata; never invent reviewer policy or tool capabilities. */
export function approvalReviewCatalog(value: unknown, settings: ApprovalReviewSettings) {
  const source = object(value)
  if (!source || !Array.isArray(source.models) || !source.models.length || source.models.length > 20_000) {
    throw new Error('REVIEW_CATALOG_INVALID')
  }
  const ids = new Set<string>()
  const rows = source.models.map(value => {
    const row = object(value)
    if (
      !row || typeof row.slug !== 'string' || !row.slug || ids.has(row.slug)
      || typeof row.display_name !== 'string' || typeof row.supported_in_api !== 'boolean'
      || !Array.isArray(row.supported_reasoning_levels) || typeof row.shell_type !== 'string'
      || typeof row.visibility !== 'string' || !Number.isSafeInteger(row.priority)
      || typeof row.support_verbosity !== 'boolean' || !object(row.truncation_policy)
      || !Array.isArray(row.experimental_supported_tools)
    ) {
      throw new Error('REVIEW_CATALOG_INVALID')
    }
    ids.add(row.slug)
    return row
  })
  for (const [parent, reviewer] of Object.entries(settings.models ?? {})) {
    if (!ids.has(parent) || !ids.has(reviewer)) throw new Error('REVIEW_MODEL_NOT_IN_CATALOG')
  }
  if (settings.defaultModel && !ids.has(settings.defaultModel)) throw new Error('REVIEW_MODEL_NOT_IN_CATALOG')
  const models: Record<string, unknown>[] = rows.map(row => {
    const reviewer = settings.models?.[String(row.slug)] ?? settings.defaultModel
    if (reviewer === undefined) return { ...row }
    const target = rows.find(candidate => candidate.slug === reviewer)!
    if (target.supported_in_api !== true) throw new Error('REVIEW_MODEL_NOT_API_SUPPORTED')
    const policy = object(object(target.model_messages)?.auto_review)
    if (
      typeof policy?.policy_template !== 'string' || !policy.policy_template.trim()
      || typeof policy.policy !== 'string' || !policy.policy.trim()
    ) throw new Error('REVIEW_POLICY_UNAVAILABLE')
    return { ...row, auto_review_model_override: reviewer }
  })
  return { ...source, models }
}

export async function readApprovalReviewCatalog(settings: ApprovalReviewSettings, configPath: string) {
  const file = path.resolve(path.dirname(configPath), settings.catalogPath)
  const data = await readFile(file).catch(() => {
    throw new Error('REVIEW_CATALOG_UNAVAILABLE')
  })
  if (data.length > 16 * 1024 * 1024) throw new Error('REVIEW_CATALOG_TOO_LARGE')
  let source: unknown
  try {
    source = JSON.parse(data.toString('utf8'))
  } catch {
    throw new Error('REVIEW_CATALOG_INVALID')
  }
  return approvalReviewCatalog(source, settings)
}

/** A private immutable snapshot, consumed before native startup and removed only after its child exits. */
export async function prepareApprovalReviewCatalog(input: {
  settings?: ApprovalReviewSettings | undefined
  configPath: string
  nativeVersion: string
  temporaryRoot?: string
}) {
  if (!input.settings) return undefined
  if (!(REVIEW_CATALOG_NATIVE_VERSIONS as readonly string[]).includes(input.nativeVersion)) {
    throw new Error('REVIEW_NATIVE_VERSION_UNSUPPORTED')
  }
  const catalog = await readApprovalReviewCatalog(input.settings, input.configPath)
  const bytes = Buffer.from(JSON.stringify(catalog))
  const directory = await mkdtemp(path.join(input.temporaryRoot ?? os.tmpdir(), 'cx-review-catalog-'))
  try {
    const file = path.join(directory, 'catalog.json')
    await writeFile(file, bytes, { flag: 'wx', mode: 0o400 })
    await chmod(file, 0o400)
    return {
      path: file,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      nativeVersion: input.nativeVersion,
      providerId: input.settings.providerId,
      modelIds: catalog.models.map(row => String(row.slug)),
      close: () => rm(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export function approvalReviewCatalogEnvironment(catalog?: Awaited<ReturnType<typeof prepareApprovalReviewCatalog>>) {
  return catalog
    ? {
      CORDISX_NATIVE_REVIEW_CATALOG_PATH: catalog.path,
      CORDISX_NATIVE_REVIEW_CATALOG_SHA256: catalog.sha256,
      CORDISX_NATIVE_REVIEW_CATALOG_VERSION: catalog.nativeVersion,
      CORDISX_NATIVE_REVIEW_PROVIDER: catalog.providerId,
    }
    : {}
}
