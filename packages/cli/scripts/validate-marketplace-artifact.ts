import { readFile } from 'node:fs/promises'
import {
  parseMarketplaceArtifactBindingRequest,
  validateMarketplaceArtifactArchive,
} from '../src/launcher/marketplace-artifact.js'

const [requestPath, archivePath] = process.argv.slice(2)
if (requestPath === undefined || archivePath === undefined || process.argv.length !== 4) {
  throw new Error('Usage: npm run validate:marketplace-artifact -- <request.json> <archive.tgz>')
}

const raw = JSON.parse(await readFile(requestPath, 'utf8')) as unknown
const parsed = parseMarketplaceArtifactBindingRequest({
  kind: 'inspect',
  requestId: 'archive-validation',
  request: raw,
})
if (parsed.kind === 'cancel') throw new Error('Marketplace archive validation request is invalid')

console.log(JSON.stringify(await validateMarketplaceArtifactArchive(archivePath, parsed.request), null, 2))
