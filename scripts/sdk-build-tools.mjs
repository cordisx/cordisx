import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export const json = async file => JSON.parse(await readFile(file, 'utf8'))
export const save = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
export const digest = async (file, algorithm = 'sha256') =>
  createHash(algorithm).update(await readFile(file)).digest(algorithm === 'sha512' ? 'base64' : 'hex')

export async function run(command, args, cwd, env = process.env) {
  try {
    return (await execute(command, args, { cwd, env, maxBuffer: 32 * 1024 * 1024 })).stdout.trim()
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} failed\n${error.stdout ?? ''}${error.stderr ?? ''}`, { cause: error })
  }
}

export function gitReference(spec) {
  const match = /^(?:github:|git\+ssh:\/\/git@github.com\/)([^#]+?)(?:\.git)?#([a-f0-9]{40})$/.exec(spec)
  if (!match) throw new Error(`SDK Git dependency must pin a full GitHub commit: ${spec}`)
  return { repository: match[1], commit: match[2] }
}

export async function checkout(spec, destination) {
  const reference = gitReference(spec)
  await mkdir(destination, { recursive: true })
  await run('git', ['init', '--quiet'], destination)
  await run('git', [
    'fetch',
    '--quiet',
    '--depth=1',
    `https://github.com/${reference.repository}.git`,
    reference.commit,
  ], destination)
  await run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], destination)
  if (await run('git', ['rev-parse', 'HEAD'], destination) !== reference.commit) throw new Error('Git source mismatch')
}

export async function pack(source, output) {
  await mkdir(output, { recursive: true })
  const report = JSON.parse(
    await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], source),
  )
  if (report.length !== 1) throw new Error(`Expected one package from ${source}`)
  return path.join(output, report[0].filename)
}

// Resolve external plugin build tools from the fresh, locked Host installation.
// Links live only in this disposable build tree; none enter an output tarball.
export async function linkBuildDependencies(source, host) {
  const target = path.join(source, 'node_modules')
  await mkdir(target, { recursive: true })
  for (const modules of [path.join(host, 'node_modules'), path.join(host, 'packages/cli/node_modules')]) {
    for (const entry of await readdir(modules, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const names = entry.name.startsWith('@')
        ? (await readdir(path.join(modules, entry.name))).map(name => `${entry.name}/${name}`)
        : [entry.name]
      for (const name of names) {
        const destination = path.join(target, name)
        await mkdir(path.dirname(destination), { recursive: true })
        await rm(destination, { force: true, recursive: true })
        await symlink(path.join(modules, name), destination, 'dir')
      }
    }
  }
  await rm(path.join(target, 'cordisx'), { force: true, recursive: true })
  await symlink(path.join(host, 'packages/cli'), path.join(target, 'cordisx'), 'dir')
}

export async function verifyPackage(source, plugin = false) {
  const manifest = await json(path.join(source, 'package.json'))
  const entries = new Set()
  function collect(value) {
    if (typeof value === 'string' && value.startsWith('./')) entries.add(value)
    else if (value && typeof value === 'object') Object.values(value).forEach(collect)
  }
  collect(manifest.exports)
  collect(manifest.main)
  collect(manifest.types)
  // Protocol uses wildcard exports; verify its published concrete directories separately.
  for (const entry of entries) if (!entry.includes('*')) await access(path.join(source, entry))
  if (plugin) {
    const declaration = await json(path.join(source, 'cordisx-package.json'))
    await access(path.join(source, declaration.entry))
    const runtimeFile = path.join(source, declaration.runtimeManifest.path)
    if (declaration.runtimeManifest.digest !== `sha256:${await digest(runtimeFile)}`) {
      throw new Error(`Runtime manifest digest mismatch: ${manifest.name}`)
    }
    const runtime = await json(runtimeFile)
    for (const service of runtime.services ?? []) await access(path.join(source, service.entry))
  }
  return manifest
}
