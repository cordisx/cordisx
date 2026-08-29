import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.resolve(cliRoot, '../schemastery-ui')
const target = path.join(cliRoot, 'node_modules/@cordisx/schemastery-ui')
const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
if (manifest.name !== '@cordisx/schemastery-ui' || manifest.version !== '0.1.0-beta.1') {
  throw new Error('refusing to bundle an unexpected @cordisx/schemastery-ui workspace package')
}

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
for (const entry of ['dist', 'README.md', 'LICENSE', 'CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md', 'package.json']) {
  await cp(path.join(source, entry), path.join(target, entry), { recursive: true })
}
