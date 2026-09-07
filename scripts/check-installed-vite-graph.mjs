import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export async function verifyGeneratedViteGraph(graphRoot, label) {
  const artifact = JSON.parse(await readFile(path.join(graphRoot, 'artifact.json'), 'utf8'))
  const entry = artifact.files?.find(file => file.path === artifact.entry)
  const hasLazyModule = artifact.files?.some(file => file.kind === 'module' && file.dynamicImports?.length > 0)
  if (
    artifact.contract !== 'cordisx.plugin-generation-artifact/v1'
    || artifact.entry !== './module.js' || entry?.kind !== 'module'
    || hasLazyModule !== true
  ) {
    throw new Error(`${label} did not emit the expected lazy Vite ESM entry`)
  }
  const chunks = await readdir(path.join(graphRoot, 'chunks'))
  if (!chunks.some(file => file.endsWith('.js'))) throw new Error(`${label} did not emit a lazy JavaScript chunk`)
}
