import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const emptyStateAssetDirectory = 'illustrations/empty-state/v4-flat'
const families = [
  'plugins',
  'model-services',
  'marketplace',
  'marketplace-sources',
  'plugin-bundles',
  'hidden-marketplace-plugins',
  'extension-points',
  'routes',
  'notification-rules',
  'acknowledgements',
]

/** Pin every approved pair; omission, accidental formatting and stale copied bytes fail the build. */
export function verifyEmptyStateAssets(assetRoot) {
  const directory = path.join(assetRoot, emptyStateAssetDirectory)
  const receipt = JSON.parse(readFileSync(path.join(directory, 'receipt.json'), 'utf8'))
  const expected = families.flatMap(family => [`${family}.svg`, `${family}.css`]).sort()
  if (
    receipt.designVersion !== 'v4-flat'
    || JSON.stringify(receipt.files.map(file => file.file).sort()) !== JSON.stringify(expected)
  ) {
    throw new Error('V4-flat receipt must contain all ten approved SVG/CSS pairs')
  }
  for (const file of receipt.files) {
    const bytes = readFileSync(path.join(directory, file.file))
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error(`V4-flat asset differs from approved receipt: ${file.file}`)
    }
  }
  return [...expected, 'receipt.json'].map(file => `${emptyStateAssetDirectory}/${file}`)
}
