import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)

describe('builds with linked dependencies', () => {
  it.each(['manager-shell', 'codex-adapter'] as const)(
    'does not expose dependency source paths in the %s bundle',
    async target => {
      const fixture = await mkdtemp(path.join(os.tmpdir(), 'cordisx-bundle-fixture-'))
      const external = await mkdtemp(path.join(os.tmpdir(), 'cordisx-external-source-'))
      const marker = path.basename(external)
      try {
        const pkg = path.join(fixture, 'packages', target === 'manager-shell' ? 'cli' : 'codex-adapter')
        const scripts = path.join(pkg, 'scripts')
        const entry = path.join(pkg, 'src', target === 'manager-shell' ? 'independent-manager/shell.tsx' : 'index.ts')
        const modules = path.join(fixture, 'node_modules')
        await Promise.all([
          mkdir(scripts, { recursive: true }),
          mkdir(path.dirname(entry), { recursive: true }),
          mkdir(path.join(pkg, 'dist'), { recursive: true }),
          mkdir(modules, { recursive: true }),
        ])
        await Promise.all([
          symlink(await realpath('node_modules/esbuild'), path.join(modules, 'esbuild'), 'dir'),
          symlink(external, path.join(modules, 'linked-fixture'), 'dir'),
          writeFile(path.join(external, 'package.json'), JSON.stringify({ name: 'linked-fixture', main: 'index.js' })),
          writeFile(path.join(external, 'index.js'), 'module.exports = 42\n'),
          writeFile(
            entry,
            "import value from 'linked-fixture'; if (value !== 42) throw new Error('bad dependency'); globalThis.__bundleFixture = value\n",
          ),
        ])
        const script = target === 'manager-shell' ? 'build-manager-shell.mjs' : 'build.mjs'
        await copyFile(
          path.join('packages', target === 'manager-shell' ? 'cli' : 'codex-adapter', 'scripts', script),
          path.join(scripts, script),
        )
        if (target === 'codex-adapter') {
          await Promise.all([
            writeFile(path.join(pkg, 'dist/index.d.ts'), 'export {}\n'),
            writeFile(path.join(pkg, 'THIRD_PARTY_NOTICES.md'), 'fixture\n'),
            writeFile(path.join(pkg, 'LICENSE'), 'fixture\n'),
          ])
        }
        await exec(process.execPath, [path.join(scripts, script)], { cwd: pkg })
        const output = path.join(
          pkg,
          'dist',
          target === 'manager-shell' ? 'assets/manager/manager-shell.js' : 'adapter.mjs',
        )
        const bundle = await readFile(output, 'utf8')
        expect(bundle).toContain('__bundleFixture')
        expect(bundle.includes(marker)).toBe(false)
        await exec(process.execPath, [output], { cwd: pkg })
      } finally {
        await Promise.all([
          rm(fixture, { recursive: true, force: true }),
          rm(external, { recursive: true, force: true }),
        ])
      }
    },
  )
})
