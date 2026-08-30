import { access } from 'node:fs/promises'

import { OwnerDocumentStore } from '../../packages/cli/src/launcher/owner-document-store.js'

async function main(): Promise<void> {
  const [home, gate, state] = process.argv.slice(2)
  if (home === undefined || gate === undefined || state === undefined) throw new Error('missing fixture arguments')
  while (true) {
    try { await access(gate); break } catch { await new Promise(resolve => setTimeout(resolve, 5)) }
  }
  const result = await new OwnerDocumentStore(home).replace({
    scope: { profileId: 'work', identity: { source: 'https://plugins.example/chatroom', pluginId: 'chatroom' } },
    documentId: 'room-registry', expectedRevision: 1, schemaVersion: 3, value: { state },
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

void main().catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1 })
