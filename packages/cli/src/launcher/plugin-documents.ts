import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { PluginDocumentReadbackV1 } from '@cordisx/protocol/plugin-documents/v1'
import { parsePluginDocumentPayload, readStoredPluginDocumentText } from './plugin-package-documents.js'

/** A data descriptor owns no prompt authority or permission. All file reads stay within one package. */
export async function readPluginDocuments(
  entry: string,
  pluginId: string,
  packageRoot?: string,
): Promise<{ documents: readonly PluginDocumentReadbackV1[]; files: readonly string[] }> {
  let root = packageRoot === undefined ? path.dirname(path.resolve(entry)) : path.resolve(packageRoot)
  if (packageRoot === undefined) {
    while (true) {
      // Stop at the owning package, including legacy local and immutable packages.
      const markers = ['package.json', 'cordisx-package.json', 'cordisx.plugin.json', 'manifest.json']
      if (
        (await Promise.all(
          markers.map(marker =>
            lstat(path.join(root, marker)).then(value => value.isFile() && !value.isSymbolicLink()).catch(() => false)
          ),
        )).some(Boolean)
      ) break
      const parent = path.dirname(root)
      if (parent === root) return { documents: [], files: [] }
      root = parent
    }
    const stored = await readStoredPluginDocumentText(root)
    if (stored !== undefined) {
      return {
        documents: parsePluginDocumentPayload(stored, pluginId),
        files: [path.join(root, 'plugin-documents.json')],
      }
    }
  }
  const descriptorPath = path.join(root, 'cordisx-documents.json')
  const descriptorStat = await lstat(descriptorPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (!descriptorStat) return { documents: [], files: [] }
  if (!descriptorStat.isFile() || descriptorStat.isSymbolicLink() || descriptorStat.size > 32_768) {
    throw new Error('INVALID_PLUGIN_DOCUMENTS')
  }
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as Record<string, unknown>
  if (
    descriptor.contract !== 'cordisx.plugin-documents/v1'
    || Object.keys(descriptor).some(key => !['contract', 'documents'].includes(key))
    || !Array.isArray(descriptor.documents) || !descriptor.documents.length || descriptor.documents.length > 32
  ) throw new Error('INVALID_PLUGIN_DOCUMENTS')
  const realRoot = await realpath(root),
    seen = new Set<string>(),
    files = [descriptorPath],
    documents: PluginDocumentReadbackV1[] = []
  let total = 0
  for (const raw of descriptor.documents) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_PLUGIN_DOCUMENTS')
    const row = raw as Record<string, unknown>
    if (
      Object.keys(row).some(key => !['id', 'title', 'path', 'locale'].includes(key)) || typeof row.id !== 'string'
      || !/^[a-z][a-z0-9-]{0,63}$/u.test(row.id)
      || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 120
      || /[\p{Cc}\p{Cf}]/u.test(row.title)
      || typeof row.path !== 'string' || !/^\.\/[a-zA-Z0-9_./-]+\.md$/u.test(row.path) || row.path.length > 240
      || row.locale !== undefined
        && (typeof row.locale !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(row.locale))
    ) throw new Error('INVALID_PLUGIN_DOCUMENTS')
    const parts = row.path.slice(2).split('/')
    if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('INVALID_PLUGIN_DOCUMENT_PATH')
    if (!/^\.\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.md$/u.test(row.path)) {
      throw new Error('INVALID_PLUGIN_DOCUMENT_PATH')
    }
    const id = JSON.stringify([row.id, (row.locale as string | undefined)?.toLowerCase() ?? ''])
    if (seen.has(id)) throw new Error('DUPLICATE_PLUGIN_DOCUMENT')
    seen.add(id)
    let file = root
    for (let i = 0; i < parts.length; i++) {
      file = path.join(file, parts[i]!)
      const stat = await lstat(file)
      if (
        stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() || stat.size > 262_144 : !stat.isDirectory())
      ) throw new Error('INVALID_PLUGIN_DOCUMENT_PATH')
      if (i === parts.length - 1) total += stat.size
    }
    const actual = await realpath(file)
    if (!actual.startsWith(realRoot + path.sep) || total > 1_048_576) throw new Error('INVALID_PLUGIN_DOCUMENT_PATH')
    const content = await readFile(actual, 'utf8')
    documents.push({
      contract: 'cordisx.plugin-document-readback/v1',
      pluginId,
      id: row.id,
      title: row.title,
      ...(typeof row.locale === 'string' ? { locale: row.locale } : {}),
      content,
    })
    files.push(file)
  }
  return { documents, files }
}

export async function configuredPluginDocuments(
  plugins: readonly { id: string; entry: string; enabled: boolean; documents?: readonly PluginDocumentReadbackV1[] }[],
  input: unknown,
) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_DOCUMENT_REQUEST')
  const row = input as Record<string, unknown>
  if (Object.keys(row).some(key => !['pluginId', 'id', 'locale'].includes(key))) {
    throw new Error('INVALID_DOCUMENT_REQUEST')
  }
  if (
    row.pluginId !== undefined && (typeof row.pluginId !== 'string' || !row.pluginId)
    || row.id !== undefined && (typeof row.id !== 'string' || !row.id)
    || row.locale !== undefined
      && (typeof row.locale !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(row.locale))
  ) throw new Error('INVALID_DOCUMENT_REQUEST')
  const selected = row.pluginId === undefined
    ? plugins.filter(plugin => plugin.enabled)
    : plugins.filter(plugin => plugin.enabled && plugin.id === row.pluginId)
  if (row.pluginId !== undefined && !selected.length) throw new Error('DOCUMENT_PLUGIN_UNAVAILABLE')
  const documents = (await Promise.all(selected.map(plugin =>
    plugin.documents === undefined
      ? readPluginDocuments(plugin.entry, plugin.id)
      : Promise.resolve({ documents: plugin.documents })
  ))).flatMap(
    result => result.documents,
  )
  if (row.id === undefined) {
    return {
      status: 'ok',
      documents: documents.map(({ content: _content, ...metadata }) => metadata),
    }
  }
  const candidates = documents.filter(document => document.id === row.id)
  if (new Set(candidates.map(document => document.pluginId)).size > 1) throw new Error('DOCUMENT_PLUGIN_REQUIRED')
  const locale = typeof row.locale === 'string' ? row.locale.toLowerCase() : undefined
  const document = candidates.find(document => document.locale?.toLowerCase() === locale)
    ?? (locale
      ? candidates.find(document => document.locale?.split('-')[0]?.toLowerCase() === locale.split('-')[0])
      : undefined)
    ?? candidates.find(document => !document.locale) ?? candidates[0]
  if (!document) throw new Error('DOCUMENT_NOT_FOUND')
  return { status: 'ok', document }
}
