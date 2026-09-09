import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { linkBuildDependencies, pack, run } from '../scripts/sdk-build-tools.mjs'

it('packs an installed package without invoking missing build scripts or changing its manifest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-sdk-pack-'))
  const source = path.join(root, 'installed')
  try {
    await mkdir(source)
    const manifest = JSON.stringify({
      name: 'installed-runtime-fixture',
      version: '1.0.0',
      files: ['dist'],
      scripts: {
        prepack: 'node scripts/missing-prepack.cjs',
        prepare: 'node scripts/missing-build.cjs',
        postpack: 'node scripts/missing-postpack.cjs',
      },
    })
    await writeFile(path.join(source, 'package.json'), manifest)
    await mkdir(path.join(source, 'dist'))
    await writeFile(path.join(source, 'dist/index.js'), 'export const ready = true\n')
    const archive = await pack(source, path.join(root, 'output'))
    expect(await run('tar', ['-xOf', archive, 'package/package.json'], root)).toBe(manifest)
    expect(await run('tar', ['-xOf', archive, 'package/dist/index.js'], root)).toBe('export const ready = true')
    expect(await readFile(path.join(source, 'package.json'), 'utf8')).toBe(manifest)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('uses locked plugin-local tools before an incompatible ancestor npm bin', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-sdk-tools-'))
  const host = path.join(root, 'host')
  const source = path.join(root, 'outer/build/sources/plugin')
  const outerBin = path.join(root, 'outer/node_modules/.bin')
  const hostBin = path.join(host, 'node_modules/.bin')
  const cliBin = path.join(host, 'packages/cli/node_modules/.bin')
  try {
    for (const directory of [source, outerBin, hostBin, cliBin]) await mkdir(directory, { recursive: true })
    await writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({
        private: true,
        scripts: { build: 'tsc && vite' },
      }),
    )
    for (
      const [bin, name, body] of [
        [outerBin, 'tsc', 'process.exit(99)'],
        [hostBin, 'tsc', 'console.log("locked TypeScript")'],
        [hostBin, 'vite', 'process.exit(98)'],
        [cliBin, 'vite', 'console.log("locked CLI Vite")'],
      ]
    ) {
      const file = path.join(bin!, name!)
      await writeFile(file, `#!${process.execPath}\n${body}\n`)
      await chmod(file, 0o755)
    }
    await linkBuildDependencies(source, host)
    const result = await run('npm', ['run', 'build'], source, {
      ...process.env,
      PATH: `${outerBin}${path.delimiter}${process.env.PATH}`,
    })
    expect(result).toContain('locked TypeScript')
    expect(result).toContain('locked CLI Vite')
    expect(await readFile(path.join(source, 'package.json'), 'utf8')).not.toContain('skipLibCheck')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
