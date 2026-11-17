import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { CodexAppServerRpc } from '../providers/codex-app-server.js'
import type { NativeStaticCatalogReceipt } from './native-context-budget-provenance.js'
import { unmanagedCatalogProvider } from './headless-static-catalog.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Bind the bytes to the owned server only after its startup config confirms the exact catalog. */
export async function bindHeadlessCatalog(input: {
  readonly server: CodexAppServerRpc
  readonly catalog: { readonly path: string; readonly bytes: Uint8Array; readonly sha256: string }
  readonly nativeVersion: string
  readonly cwd: string
}): Promise<NativeStaticCatalogReceipt | undefined> {
  try {
    const config = object(
      object(await input.server.request('config/read', { cwd: input.cwd, includeLayers: false })).config,
    )
    const requirementsValue = object(await input.server.request('configRequirements/read', {})).requirements
    const bytes = await readFile(input.catalog.path)
    if (
      config.model_catalog_json !== input.catalog.path || config.model_provider !== 'openai'
      || !unmanagedCatalogProvider(requirementsValue)
      || createHash('sha256').update(bytes).digest('hex') !== input.catalog.sha256
      || !bytes.equals(Buffer.from(input.catalog.bytes))
    ) return undefined
    return {
      nativeVersion: input.nativeVersion,
      serverId: input.server.generation,
      providerKind: 'openai-compatible',
      providerId: 'openai',
      catalogSha256: input.catalog.sha256,
      catalogBytes: input.catalog.bytes,
    }
  } catch {
    return undefined
  }
}
