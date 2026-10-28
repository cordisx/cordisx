import { extractFile, listPackage } from '@electron/asar'
import path from 'node:path'
import { initSync, parse } from 'es-module-lexer'
import { literal, parseNativeSource } from './native-source-structure.js'
import type { NativeScriptResource } from './native-submission-structure.js'

/** Read installed resources without extracting, modifying, or launching the App. */
export function readNativeSubmissionResources(contents: string): readonly NativeScriptResource[] {
  const archive = path.join(contents, 'Resources', 'app.asar')
  const packageEntries = listPackage(archive, { isPack: false })
  const assets = new Set(
    packageEntries.filter(entry => /^\/webview\/assets\/[^/]+\.js$/u.test(entry)),
  )
  const entries = packageEntries.includes('/webview/index.html')
    ? [...extractFile(archive, 'webview/index.html').toString('utf8').matchAll(/<script\b[^>]*>/giu)]
      .flatMap(([tag]) => {
        const src = /\bsrc\s*=\s*(["'])(.*?)\1/iu.exec(tag)?.[2]
        if (!src || !/^\.?\/?assets\//u.test(src)) return []
        const entry = path.posix.resolve('/webview', src.startsWith('/') ? `.${src}` : src)
        return assets.has(entry) ? [entry] : []
      })
    : [...assets].filter(entry => /^\/webview\/assets\/app-(?:initial|primary|shared)-[^/]+\.js$/u.test(entry))
  if (entries.length === 0) throw new Error('Native resource discovery: no local application entry scripts')
  initSync()
  const discovered = new Set(entries)
  const resources: NativeScriptResource[] = []
  // Follow static and literal dynamic imports, regardless of how the bundler names chunks.
  for (const entry of discovered) {
    const source = extractFile(archive, entry.slice(1)).toString('utf8')
    // Only capability-bearing modules need the heavier syntax analysis. A dependency
    // graph can include unrelated tool/browser bundles with thousands of chunks.
    if (
      entries.includes(entry) || [
        ['submitTarget', 'options', 'openingPromptForHistory'],
        ['context', 'configOverrides', 'requiresThreadReferences'],
        ['configOverrides', 'threadStartKind', 'requiresThreadReferences'],
        ['context', 'targetConversationId', 'clientUserMessageId'],
        ['inheritThreadSettings', 'usePermissionSelection'],
        ['projectAssignment', 'conversationResponse', 'localTurnMetadata'],
        ['sendRequest', 'turn/start', 'getAppServerVersion'],
        ['onSelectModel', 'onSelectModelOption', 'reasoningEffort'],
        ['accessInputs', 'readAccountInfo'],
        ['create_thread', 'argumentsValue', 'sourceThreadId', 'parentTurnId'],
      ].some(keys => keys.every(key => source.includes(key)))
    ) {
      resources.push({ url: `app://-/assets/${path.basename(entry)}`, source })
    }
    const [imports] = parse(source)
    for (const dependency of imports) {
      const expression = source.slice(dependency.s, dependency.e)
      const specifier = dependency.n ?? (dependency.d >= 0 && expression.startsWith('`') && !expression.includes('${')
        ? literal(parseNativeSource(`(${expression})`).body[0]?.expression)
        : undefined)
      if (typeof specifier !== 'string' || !specifier.startsWith('.')) continue
      const target = path.posix.resolve(path.posix.dirname(entry), specifier)
      if (!assets.has(target) || discovered.has(target)) continue
      discovered.add(target)
    }
  }
  return resources
}
