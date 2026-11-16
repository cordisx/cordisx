import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { PluginDocumentReadbackV1 } from '@cordisx/protocol/plugin-documents/v1'

const CONTRACT = 'cordisx.launcher-plugin-documents/v1'
const MAX_CONTENT_BYTES = 1_048_576
// JSON escaping may require six bytes per content character.
const MAX_PAYLOAD_BYTES = 6_400_000

/** Immutable documents are package data and never supply executable prompt authority. */
export function pluginDocumentPayload(documents: readonly PluginDocumentReadbackV1[]): string | undefined {
  return documents.length ? `${JSON.stringify({ contract: CONTRACT, documents })}\n` : undefined
}

export async function readStoredPluginDocumentText(directory: string): Promise<string | undefined> {
  const file = path.join(directory, 'plugin-documents.json')
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!stat) return undefined
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PAYLOAD_BYTES) {
    throw new Error('plugin documents failed integrity readback')
  }
  const bytes = await readFile(file)
  if (bytes.byteLength !== stat.size) throw new Error('plugin documents failed integrity readback')
  return bytes.toString('utf8')
}

export function parsePluginDocumentPayload(
  text: string | undefined,
  pluginId: string,
): readonly PluginDocumentReadbackV1[] {
  if (text === undefined) return Object.freeze([])
  if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) throw new Error('INVALID_PLUGIN_DOCUMENTS')
  const payload: unknown = JSON.parse(text)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('INVALID_PLUGIN_DOCUMENTS')
  const row = payload as Record<string, unknown>
  if (
    row.contract !== CONTRACT || Object.keys(row).some(key => !['contract', 'documents'].includes(key))
    || !Array.isArray(row.documents) || !row.documents.length || row.documents.length > 32
  ) throw new Error('INVALID_PLUGIN_DOCUMENTS')
  let total = 0
  const seen = new Set<string>()
  const documents = row.documents.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_PLUGIN_DOCUMENTS')
    const document = value as Record<string, unknown>
    if (
      Object.keys(document).some(key => !['contract', 'pluginId', 'id', 'title', 'locale', 'content'].includes(key))
      || document.contract !== 'cordisx.plugin-document-readback/v1' || document.pluginId !== pluginId
      || typeof document.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(document.id)
      || typeof document.title !== 'string' || !document.title.trim() || document.title.length > 120
      || /[\p{Cc}\p{Cf}]/u.test(document.title)
      || document.locale !== undefined && (typeof document.locale !== 'string'
          || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(document.locale))
      || typeof document.content !== 'string' || Buffer.byteLength(document.content) > 262_144
    ) throw new Error('INVALID_PLUGIN_DOCUMENTS')
    const key = JSON.stringify([document.id, (document.locale as string | undefined)?.toLowerCase() ?? ''])
    if (seen.has(key)) throw new Error('DUPLICATE_PLUGIN_DOCUMENT')
    seen.add(key)
    total += Buffer.byteLength(document.content)
    if (total > MAX_CONTENT_BYTES) throw new Error('INVALID_PLUGIN_DOCUMENTS')
    return Object.freeze(document as unknown as PluginDocumentReadbackV1)
  })
  return Object.freeze(documents)
}
