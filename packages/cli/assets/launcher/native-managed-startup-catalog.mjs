import { createHash } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = value => Number.isSafeInteger(value) && value > 0
const text = value =>
  typeof value === 'string' && value.length > 0 && value.length <= 512
  && !/[\0\r\n]/u.test(value)
const hash = value => createHash('sha256').update(value).digest('hex')
const unavailable = reason => Object.freeze({ status: 'unavailable', reason })
const effortOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

function reasoning(value) {
  if (value === undefined) return null
  if (
    !object(value) || Object.keys(value).some(key => !['efforts', 'defaultEffort'].includes(key))
    || !Array.isArray(value.efforts) || value.efforts.length === 0
    || value.efforts.some(effort => !effortOrder.includes(effort))
    || new Set(value.efforts).size !== value.efforts.length
    || (value.defaultEffort !== undefined && !value.efforts.includes(value.defaultEffort))
  ) return undefined
  const efforts = [...value.efforts].sort((left, right) => effortOrder.indexOf(left) - effortOrder.indexOf(right))
  return { efforts, ...(value.defaultEffort === undefined ? {} : { defaultEffort: value.defaultEffort }) }
}

/**
 * Construct a provider-specific catalog only from complete native metadata.
 * The caller must attest that `baseBytes` are the catalog the same executable
 * would use at startup; a cache file or catalog path alone is not such proof.
 * Unknown models are not synthesized from another model's capabilities.
 */
export function projectNativeManagedStartupCatalog(input) {
  if (
    !object(input) || input.nativeVersion !== '0.149.1' || !text(input.providerId)
    || !text(input.pluginId) || !text(input.serviceId)
    || !text(input.catalogGeneration) || !text(input.serviceGeneration) || !(input.baseBytes instanceof Uint8Array)
    || input.baseBytes.length === 0 || input.baseBytes.length > 16 * 1024 * 1024
    || !Array.isArray(input.routes) || input.routes.length === 0 || input.routes.length > 4096
  ) {
    return unavailable('unsupported-input')
  }
  let source
  try {
    source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.baseBytes))
  } catch {
    return unavailable('invalid-catalog')
  }
  if (
    !object(source) || !Array.isArray(source.models) || source.models.length === 0
    || source.models.length > 20_000
  ) return unavailable('invalid-catalog')
  const rows = new Map()
  for (const model of source.models) {
    if (
      !object(model) || !text(model.slug) || rows.has(model.slug)
      || typeof model.display_name !== 'string' || typeof model.supported_in_api !== 'boolean'
      || !Array.isArray(model.supported_reasoning_levels) || typeof model.shell_type !== 'string'
      || typeof model.visibility !== 'string' || !Number.isSafeInteger(model.priority)
      || typeof model.support_verbosity !== 'boolean' || !object(model.truncation_policy)
      || !Array.isArray(model.experimental_supported_tools)
    ) return unavailable('invalid-catalog')
    rows.set(model.slug, model)
  }
  const ids = new Set()
  const overrides = new Map()
  const routes = []
  for (const route of input.routes) {
    if (
      !object(route) || !text(route.gatewayModelId) || ids.has(route.gatewayModelId)
      || !Array.isArray(route.aliases) || route.aliases.length === 0 || route.aliases.length > 4096
      || route.aliases.some(alias => !text(alias)) || new Set(route.aliases).size !== route.aliases.length
      || (route.contextWindow !== undefined && !positive(route.contextWindow))
    ) {
      return unavailable('invalid-route')
    }
    ids.add(route.gatewayModelId)
    const capabilities = reasoning(route.reasoningCapabilities)
    if (capabilities === undefined) return unavailable('invalid-route')
    const original = rows.get(route.gatewayModelId)
    // Native fallback metadata has its own guessed context window. Do not
    // claim a route is projected when there is no exact native model entry.
    if (!original) return unavailable('model-metadata-unavailable')
    // Token-budget policy can encode model-specific absolute thresholds. Do
    // not reinterpret one for a different upstream window without evidence.
    if (object(original.model_messages) && original.model_messages.token_budget != null) {
      return unavailable('model-budget-unavailable')
    }
    const compact = original.auto_compact_token_limit
    if (compact != null && !positive(compact)) return unavailable('model-budget-unavailable')
    const window = route.contextWindow ?? null
    const compactLimit = window === null || compact == null
      ? null
      : Math.min(compact, Number(BigInt(window) * 9n / 10n))
    overrides.set(route.gatewayModelId, {
      ...original,
      context_window: window,
      max_context_window: window,
      default_reasoning_level: capabilities?.defaultEffort ?? null,
      supported_reasoning_levels: capabilities === null
        ? []
        : capabilities.efforts.map(effort => ({ effort, description: '' })),
      auto_compact_token_limit: compactLimit,
    })
    const aliases = [...route.aliases].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    routes.push([route.gatewayModelId, aliases, window, capabilities])
  }
  routes.sort((left, right) => Buffer.compare(Buffer.from(left[0]), Buffer.from(right[0])))
  const bytes = Buffer.from(JSON.stringify({
    ...source,
    models: source.models.map(model => overrides.get(model.slug) ?? model),
  }))
  if (bytes.length > 16 * 1024 * 1024) return unavailable('catalog-too-large')
  const sha256 = hash(bytes)
  const revision = hash(JSON.stringify([
    input.providerId,
    input.pluginId,
    input.serviceId,
    input.serviceGeneration,
    input.catalogGeneration,
    hash(input.baseBytes),
    routes,
    sha256,
  ]))
  return Object.freeze({ status: 'ready', bytes, sha256, revision })
}

/** The caller keeps this private immutable file until its native worker exits. */
export async function prepareNativeManagedStartupCatalog(input) {
  const projected = projectNativeManagedStartupCatalog(input)
  if (projected.status !== 'ready') return projected
  const directory = await mkdtemp(path.join(input.temporaryRoot ?? os.tmpdir(), 'cx-managed-catalog-'))
  try {
    await chmod(directory, 0o700)
    const file = path.join(directory, 'catalog.json')
    await writeFile(file, projected.bytes, { flag: 'wx', mode: 0o400 })
    await chmod(file, 0o400)
    let closed
    return Object.freeze({
      status: 'ready',
      path: file,
      sha256: projected.sha256,
      revision: projected.revision,
      close: () => closed ??= rm(directory, { recursive: true, force: true }),
    })
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}
