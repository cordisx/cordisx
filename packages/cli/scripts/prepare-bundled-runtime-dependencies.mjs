import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { json, pack, run, save, verifyPackage } from '../../../scripts/sdk-build-tools.mjs'

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const host = path.resolve(cli, '../..')
const manifest = await json(path.join(cli, 'package.json'))
// Protocol carries unique-symbol brands and must resolve through the consumer's
// shared dependency graph, never a private bundled module instance.
await rm(path.join(cli, 'node_modules/@cordisx/protocol'), { recursive: true, force: true })
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cordisx-runtime-pack-'))
try {
  for (const name of ['@cordisx/channel', '@cordisx/plugin-cli-proxy-api']) {
    const source = path.join(host, 'node_modules', name)
    await verifyPackage(source, name !== '@cordisx/protocol')
    const tarball = await pack(source, temporary)
    const destination = path.join(cli, 'node_modules', name)
    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true })
    await run('tar', ['-xf', tarball, '--strip-components=1', '-C', destination], cli)
    await verifyPackage(destination, true)
    const packageFile = path.join(destination, 'package.json')
    // npm validates bundled Git edges through their resolved source metadata.
    await save(packageFile, { ...await json(packageFile), _resolved: manifest.dependencies[name] })
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
