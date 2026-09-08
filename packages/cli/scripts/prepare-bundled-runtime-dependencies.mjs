import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pack, run, verifyPackage } from '../../../scripts/sdk-build-tools.mjs'

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const host = path.resolve(cli, '../..')
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cordisx-runtime-pack-'))
try {
  for (const name of ['@cordisx/channel', '@cordisx/plugin-cli-proxy-api', '@cordisx/protocol']) {
    const source = path.join(host, 'node_modules', name)
    await verifyPackage(source, name !== '@cordisx/protocol')
    const tarball = await pack(source, temporary)
    const destination = path.join(cli, 'node_modules', name)
    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true })
    await run('tar', ['-xf', tarball, '--strip-components=1', '-C', destination], cli)
    await verifyPackage(destination, name !== '@cordisx/protocol')
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
