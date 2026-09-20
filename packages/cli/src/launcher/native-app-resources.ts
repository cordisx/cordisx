import { extractFile, listPackage } from '@electron/asar'
import path from 'node:path'
import type { NativeScriptResource } from './native-submission-structure.js'

/** Read installed resources without extracting, modifying, or launching the App. */
export function readNativeSubmissionResources(contents: string): readonly NativeScriptResource[] {
  const archive = path.join(contents, 'Resources', 'app.asar')
  const entries = listPackage(archive, { isPack: false }).filter(entry =>
    /^\/webview\/assets\/app-(?:initial|primary)-[^/]+\.js$/u.test(entry)
  )
  for (const role of ['initial', 'primary']) {
    const matches = entries.filter(entry => path.basename(entry).startsWith(`app-${role}-`))
    if (matches.length !== 1) {
      throw new Error(`Native resource discovery: expected one ${role} script, found ${matches.length}`)
    }
  }
  return entries.map(entry => ({
    url: `app://-/assets/${path.basename(entry)}`,
    source: extractFile(archive, entry.slice(1)).toString('utf8'),
  }))
}
