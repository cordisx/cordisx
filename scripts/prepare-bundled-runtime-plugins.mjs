import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkout, json, linkPluginBuildDependencies, pack, run, save, verifyPackage } from './sdk-build-tools.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliRoot = path.join(repositoryRoot, 'packages/cli')
const manifest = await json(path.join(cliRoot, 'package.json'))
const targetRoot = path.join(cliRoot, 'dist/bundled-plugins')
const sources = manifest.cordisxSources
const expected = ['@cordisx/channel', '@cordisx/plugin-cli-proxy-api']

if (sources === undefined || expected.some(name => typeof sources[name] !== 'string')) {
  throw new Error('cordisxSources must provide exact Channel and CLIProxy Git revisions')
}

await rm(targetRoot, { recursive: true, force: true })
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cordisx-runtime-plugins-'))
try {
  for (const name of expected) {
    const spec = sources[name]
    const source = path.join(temporary, 'sources', name.replaceAll('/', '__'))
    await checkout(spec, source)
    await linkPluginBuildDependencies(source, repositoryRoot)
    await run('npm', ['run', 'build'], source, {
      ...process.env,
      PATH: [
        path.join(repositoryRoot, 'node_modules/.bin'),
        path.join(cliRoot, 'node_modules/.bin'),
        process.env.PATH,
      ].join(path.delimiter),
    })
    await verifyPackage(source, true)

    const tarball = await pack(source, path.join(temporary, 'packages'))
    const destination = path.join(targetRoot, name)
    await mkdir(destination, { recursive: true })
    await run('tar', ['-xf', tarball, '--strip-components=1', '-C', destination], repositoryRoot)
    await verifyPackage(destination, true)
    const packageFile = path.join(destination, 'package.json')
    await save(packageFile, { ...JSON.parse(await readFile(packageFile, 'utf8')), cordisxSource: spec })
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
