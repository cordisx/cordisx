import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkout, digest, json, linkBuildDependencies, pack, run, save, verifyPackage } from './sdk-build-tools.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.resolve(process.argv[2] ?? path.join(repository, 'artifacts/sdk'))
// Refuse reuse: a successful build must never borrow an existing installation.
await mkdir(output)
const host = path.join(output, 'host')
await mkdir(host)
const commit = await run('git', ['rev-parse', 'HEAD'], repository)
const archive = path.join(output, 'host-source.tar')
await run('git', ['archive', '--format=tar', '--output', archive, commit], repository)
await run('tar', ['-xf', archive, '-C', host], repository)
const lockFile = path.join(host, 'package-lock.json')
const lock = await json(lockFile)
const originals = new Map([[lockFile, await readFile(lockFile)]])
const prepared = new Map()
const records = []

console.log(`[sdk] building Host ${commit} in ${output}`)
for (const [location, dependency] of Object.entries(lock.packages)) {
  if (!dependency.resolved?.startsWith('git+')) continue
  const spec = dependency.resolved
  let item = prepared.get(spec)
  if (!item) {
    const source = path.join(output, 'sources', String(prepared.size))
    console.log(`[sdk] materializing ${spec}`)
    await checkout(spec, source)
    const tarball = await pack(source, path.join(output, 'bootstrap', String(prepared.size)))
    item = { source, tarball, integrity: `sha512-${await digest(tarball, 'sha512')}` }
    prepared.set(spec, item)
  }
  dependency.resolved = `file:${item.tarball}`
  dependency.integrity = item.integrity
  records.push({ location, spec, ...item })
}

function replaceReferences(manifest) {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (!spec.startsWith('github:')) continue
      const match = records.find(record =>
        record.spec.endsWith(`#${spec.split('#')[1]}`)
        && record.location.endsWith(`node_modules/${name}`)
      )
      if (!match) throw new Error(`Missing locked Git source for ${name}: ${spec}`)
      manifest[field][name] = `file:${match.tarball}`
    }
  }
}
for (const [location, entry] of Object.entries(lock.packages)) {
  replaceReferences(entry)
  if (location.includes('node_modules')) continue
  const manifestFile = path.join(host, location, 'package.json')
  originals.set(manifestFile, await readFile(manifestFile))
  const manifest = await json(manifestFile)
  replaceReferences(manifest)
  await save(manifestFile, manifest)
}
await save(lockFile, lock)
console.log('[sdk] installing locked registry dependencies without Git prepare recursion')
await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], host)
// Published metadata and the retained build tree always keep canonical Git refs.
for (const [file, bytes] of originals) await writeFile(file, bytes)
console.log('[sdk] compiling Host')
await run('npm', ['run', 'build'], host)
const cli = path.join(host, 'packages/cli')
const cliManifest = await json(path.join(cli, 'package.json'))
const artifacts = path.join(output, 'packages')
for (const name of ['@cordisx/channel', '@cordisx/plugin-cli-proxy-api', '@cordisx/protocol']) {
  const spec = cliManifest.dependencies[name]
  const record = records.find(item => item.location === `node_modules/${name}`)
  if (!record || !record.spec.endsWith(`#${spec.split('#')[1]}`)) throw new Error(`Unpinned output: ${name}`)
  if (name !== '@cordisx/protocol') {
    console.log(`[sdk] compiling ${name}`)
    await linkBuildDependencies(record.source, host)
    await run('npm', ['run', 'build'], record.source, {
      ...process.env,
      PATH: [path.join(host, 'node_modules/.bin'), path.join(cli, 'node_modules/.bin'), process.env.PATH].join(
        path.delimiter,
      ),
    })
  }
  await verifyPackage(record.source, name !== '@cordisx/protocol')
  const tarball = await pack(record.source, artifacts)
  // Use npm's allowlist, not a raw source/node_modules copy.
  const destination = path.join(host, 'node_modules', name)
  await run('tar', ['-xf', tarball, '--strip-components=1', '-C', destination], host)
  await verifyPackage(destination, name !== '@cordisx/protocol')
}
await run(process.execPath, ['scripts/prepare-bundled-runtime-dependencies.mjs'], cli)
const cliTarball = await pack(cli, artifacts)
const packedFiles = (await run('tar', ['-tf', cliTarball], host)).split('\n')
for (const name of ['@cordisx/channel', '@cordisx/plugin-cli-proxy-api', '@cordisx/protocol']) {
  if (!packedFiles.includes(`package/node_modules/${name}/package.json`)) {
    throw new Error(`CLI tarball omitted bundled runtime dependency: ${name}`)
  }
}
await pack(path.join(host, 'packages/create-cordisx-plugin'), artifacts)
const packages = []
for (const filename of (await readdir(artifacts)).sort()) {
  packages.push({
    filename,
    sha256: await digest(path.join(artifacts, filename)),
    integrity: `sha512-${await digest(path.join(artifacts, filename), 'sha512')}`,
  })
}
await save(path.join(output, 'sdk-evidence.json'), {
  hostCommit: commit,
  node: process.version,
  npm: await run('npm', ['--version'], host),
  sources: records.map(({ location, spec }) => ({ location, spec })),
  packages,
})
console.log(`[sdk] verified packages and hashes: ${path.join(output, 'sdk-evidence.json')}`)
