import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import {
  packInstalledDependencyClosure,
  usePackedDependencyClosure,
} from '../scripts/installed-check-package-cache.mjs'

const externalPackages = ['@cordisx/channel', '@cordisx/plugin-cli-proxy-api', '@cordisx/protocol'] as const

it.each(['node_modules', 'node_modules/cordisx/node_modules'])(
  'repacks %s dependencies without rerunning Git prepare hooks',
  async layout => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-installed-cache-test-'))
    const runner = path.join(root, 'runner')
    const pack = path.join(root, 'pack')
    try {
      await mkdir(pack, { recursive: true })
      await Promise.all(externalPackages.map(async packageName => {
        const packageRoot = path.join(runner, layout, ...packageName.split('/'))
        await mkdir(packageRoot, { recursive: true })
        await writeFile(path.join(packageRoot, 'README.md'), packageName, 'utf8')
        await writeFile(
          path.join(packageRoot, 'package.json'),
          JSON.stringify({
            name: packageName,
            version: '1.0.0',
            files: ['README.md'],
            scripts: { prepare: 'node -e "process.exit(97)"' },
          }),
          'utf8',
        )
      }))
      const closure = await packInstalledDependencyClosure(runner, pack, process.env)
      expect(Object.keys(closure).sort()).toEqual([...externalPackages].sort())
      await Promise.all(Object.values(closure).map(async spec => await access(spec.slice('file:'.length))))
      const consumer = path.join(root, 'consumer.json')
      await writeFile(consumer, JSON.stringify({ devDependencies: { cordisx: '0.1.0' } }), 'utf8')
      await usePackedDependencyClosure(consumer, closure)
      const manifest = JSON.parse(await readFile(consumer, 'utf8'))
      expect(manifest.devDependencies).toMatchObject(closure)
      expect(manifest.overrides).toEqual(Object.fromEntries(externalPackages.map(name => [name, `$${name}`])))
      const original = JSON.parse(
        await readFile(path.join(runner, layout, '@cordisx', 'plugin-cli-proxy-api', 'package.json'), 'utf8'),
      )
      expect(original.scripts.prepare).toContain('process.exit(97)')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
