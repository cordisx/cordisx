import type { ModelExportRequest } from '../../cli/model-export-parse.js'
import type { HomeConfigEnvironmentVariable } from '../../config/home-config-environment.js'
import type { CatalogManagementSnapshot } from '../../model-catalog-management.js'
import {
  CATALOG_TRANSFER_MAX_CONNECTIONS,
  CATALOG_TRANSFER_MAX_MODELS_PER_CONNECTION,
  CATALOG_TRANSFER_MAX_REQUEST_BYTES,
  type CatalogTransferExportPreparationResult,
  type CatalogTransferExportRequest,
  type CatalogTransferExportResult,
} from '../../model-catalog-transfer.js'
import { decodePortableBundle } from './portable-transfer-codec.js'

export interface CliExportAuthority {
  snapshot(): CatalogManagementSnapshot
  prepareExport?(
    request: CatalogTransferExportRequest,
    authorized: () => boolean,
  ): CatalogTransferExportPreparationResult
  export?(request: CatalogTransferExportRequest, authorized: () => boolean): Promise<CatalogTransferExportResult>
}
export type CliModelExportResult =
  | {
    readonly kind: 'list'
    readonly complete: boolean
    readonly services: readonly {
      readonly bindingRef: string
      readonly providerId: string
      readonly title: string
      readonly exportable: boolean
      readonly models: readonly { readonly id: string; readonly label: string }[]
    }[]
  }
  | {
    readonly kind: 'export'
    readonly text: string
    readonly services: number
    readonly models: number
    readonly missingVariables: readonly string[]
  }

/** One bounded operation for both CLI transports; never serialize preparation values or runtime credentials. */
export async function exportCliModelCatalog(
  authority: CliExportAuthority,
  raw: ModelExportRequest,
  entries: readonly HomeConfigEnvironmentVariable[],
  complete = true,
): Promise<CliModelExportResult> {
  if (
    !raw || typeof raw !== 'object'
    || Object.keys(raw).some(key => !['list', 'all', 'services', 'modelIds', 'includeValues'].includes(key))
    || typeof raw.list !== 'boolean' || typeof raw.all !== 'boolean' || typeof raw.includeValues !== 'boolean'
    || !Array.isArray(raw.services) || !Array.isArray(raw.modelIds)
    || [...raw.services, ...raw.modelIds].some(id =>
      typeof id !== 'string' || !id || id.length > 512 || /[\0\r\n]/u.test(id)
    ) || Buffer.byteLength(JSON.stringify(raw)) > CATALOG_TRANSFER_MAX_REQUEST_BYTES
  ) throw new Error('Invalid or oversized model export request')
  const request = raw
  if (
    Number(request.list) + Number(request.all) + Number(request.services.length > 0) !== 1
    || request.modelIds.length > 0 && request.services.length !== 1
    || new Set(request.services).size !== request.services.length
    || new Set(request.modelIds).size !== request.modelIds.length
  ) throw new Error('Invalid model export selection')
  const views = authority.snapshot().views
  if (request.list) {
    return {
      kind: 'list',
      complete,
      services: views.map(view => ({
        bindingRef: view.bindingRef,
        providerId: view.providerId,
        title: view.title,
        exportable: view.transferAvailable === true,
        models: view.rows.filter(row => row.present).map(row => ({ id: row.id, label: row.label })),
      })),
    }
  }
  if (!complete && (request.all || request.services.some(id => !id.startsWith('codex-config:')))) {
    throw new Error(
      'Inactive catalog is incomplete. Offline export requires explicit --service codex-config:ID; --all requires an active compatible CordisX runtime',
    )
  }
  const selected = request.all ? views : request.services.map(id => {
    const matches = views.filter(view => view.bindingRef === id || view.providerId === id)
    if (matches.length !== 1) throw new Error(`Unknown or ambiguous service ID: ${id}; use model export --list`)
    return matches[0]!
  })
  if (!selected.length) throw new Error('No services to export')
  if (new Set(selected.map(view => view.bindingRef)).size !== selected.length) {
    throw new Error('Duplicate service selection')
  }
  if (selected.length > CATALOG_TRANSFER_MAX_CONNECTIONS) {
    throw new Error(`Too many services; select at most ${CATALOG_TRANSFER_MAX_CONNECTIONS} per export`)
  }
  for (const view of selected) {
    if (!view.transferAvailable) {
      throw new Error(
        `Service ${view.bindingRef} is not portable. Plugin-managed services (including Aiden/TraeX) require installing the plugin and logging in on the target machine. No partial export was written`,
      )
    }
  }
  const selections = selected.map(view => {
    const available = view.rows.filter(row => row.present)
    const availableIds = new Set(available.map(row => row.id))
    const modelIds = request.modelIds.length ? [...request.modelIds] : [...availableIds]
    if (
      !modelIds.length || modelIds.length > CATALOG_TRANSFER_MAX_MODELS_PER_CONNECTION
      || modelIds.some(id => !availableIds.has(id))
    ) throw new Error(`Invalid, empty or oversized model selection for ${view.bindingRef}`)
    return { bindingRef: view.bindingRef, modelIds }
  })
  const prepared = authority.prepareExport?.({ selections }, () => true)
  if (!prepared || prepared.status !== 'ok') {
    throw new Error(`Model export preparation rejected: ${prepared?.code ?? 'unavailable'}`)
  }
  // Preparation can contain inline/private credential values. Only named user variables
  // saved in the Home configuration are eligible for the CLI's opt-in value export.
  const variables = prepared.variables.map(variable => {
    const saved = entries.find(entry => entry.name === variable.sourceName)
    return {
      sourceName: variable.sourceName,
      name: variable.sourceName,
      ...(request.includeValues ? { value: saved?.enabled ? saved.value : '' } : {}),
      ...(saved?.description === undefined ? {} : { description: saved.description }),
      ...(saved?.generator === undefined ? {} : { generator: saved.generator }),
    }
  })
  const result = await authority.export?.({
    selections,
    variables,
    includeValues: request.includeValues && variables.length > 0,
  }, () => true)
  if (!result || result.status !== 'ok') {
    throw new Error(
      `Model export rejected: ${
        result?.code ?? 'unavailable'
      }; select fewer services/models if too large. No partial export was written`,
    )
  }
  const bundle = decodePortableBundle(result.text)
  if (
    bundle.connections.length !== selections.length || bundle.connections.some((connection, index) => {
      const ids = new Set(connection.models.map(model => model.id))
      return ids.size !== selections[index]!.modelIds.length || selections[index]!.modelIds.some(id => !ids.has(id))
    })
  ) throw new Error('Incomplete model export rejected; no partial output was written')
  return {
    kind: 'export',
    text: result.text,
    services: bundle.connections.length,
    models: bundle.connections.reduce((sum, connection) => sum + connection.models.length, 0),
    missingVariables: bundle.version === 1
      ? []
      : bundle.environment.filter(variable => !variable.value).map(variable => variable.name),
  }
}
