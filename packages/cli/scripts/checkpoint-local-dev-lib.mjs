import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, chmod, lstat, mkdir, readdir, readFile, readlink, stat } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

export const REPORT_SCHEMA = 'cordisx.checkpoint.local-development/v1'

export function sha256(value) {
  return createHash('sha256').update(
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value),
  ).digest('hex')
}

export async function pathExists(target) {
  return await access(target).then(() => true, error => {
    if (error?.code === 'ENOENT') return false
    throw error
  })
}

export async function ensurePrivateDirectory(target) {
  await mkdir(target, { recursive: true, mode: 0o700 })
  await chmod(target, 0o700)
  return target
}

export async function freeLoopbackPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to allocate a loopback port')
  await new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  return address.port
}

export function repositoryStatus(repoRoot) {
  return execFileSync('git', ['-C', repoRoot, 'status', '--porcelain=v1', '--untracked-files=all'], {
    encoding: 'utf8',
  })
}

export async function mode(target) {
  return (await stat(target)).mode & 0o777
}

export async function findNamed(root, basename) {
  const matches = []
  const visit = async directory => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
      if (error?.code === 'ENOENT') return []
      throw error
    })
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.name === basename) matches.push(target)
      if (entry.isDirectory()) await visit(target)
    }
  }
  await visit(root)
  return matches
}

async function treeRecords(root, target, output) {
  const relative = path.relative(root, target) || '.'
  const value = await lstat(target).catch(error => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (value === undefined) {
    output.push({ path: relative, kind: 'missing' })
    return
  }
  if (value.isSymbolicLink()) {
    output.push({ path: relative, kind: 'symlink', target: await readlink(target), mode: value.mode & 0o777 })
    return
  }
  if (value.isFile()) {
    const content = await readFile(target)
    output.push({
      path: relative,
      kind: 'file',
      size: content.length,
      sha256: sha256(content),
      mode: value.mode & 0o777,
    })
    return
  }
  if (!value.isDirectory()) {
    output.push({ path: relative, kind: 'other', mode: value.mode & 0o777 })
    return
  }
  output.push({ path: relative, kind: 'directory', mode: value.mode & 0o777 })
  const entries = await readdir(target, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    await treeRecords(root, path.join(target, entry.name), output)
  }
}

/** Exact file-list/content snapshot for the runtime-shaped paths a gate protects. */
export async function snapshotRuntimePaths(root, targets) {
  const resolvedRoot = path.resolve(root)
  const output = []
  for (const target of [...new Set(targets.map(item => path.resolve(resolvedRoot, item)))].sort()) {
    const relative = path.relative(resolvedRoot, target)
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`snapshot target escapes root: ${target}`)
    }
    await treeRecords(resolvedRoot, target, output)
  }
  return { root: resolvedRoot, records: output, sha256: sha256(output) }
}

export function parseCheckpointArgs(argv, defaults = {}) {
  const values = { ...defaults }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (!option.startsWith('--')) throw new Error(`unknown positional argument: ${option}`)
    if (option === '--help') return { help: true }
    const name = option.slice(2)
    if (!['executable', 'artifacts', 'repo-root', 'cli', 'cli-bin', 'timeout-ms'].includes(name)) {
      throw new Error(`unknown option: ${option}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`)
    values[name] = value
    index += 1
  }
  if (values.cli !== undefined && values['cli-bin'] !== undefined) {
    throw new Error('--cli and --cli-bin are mutually exclusive')
  }
  if (values.executable === undefined) throw new Error('--executable is required')
  for (const name of ['executable', 'artifacts', 'repo-root', 'cli', 'cli-bin']) {
    if (values[name] !== undefined && !path.isAbsolute(values[name])) throw new Error(`--${name} must be absolute`)
  }
  const timeoutMs = Number(values['timeout-ms'] ?? 30_000)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 120_000) {
    throw new Error('--timeout-ms must be an integer between 5000 and 120000')
  }
  return { ...values, timeoutMs }
}

export function invariantProjection(state) {
  return {
    ready: state.ready,
    plugin: state.plugin,
    activation: state.activation,
    runtimeGeneration: state.runtimeGeneration,
    lifecycleRevision: state.lifecycleRevision,
  }
}

export function rendererGenerationProjection(state) {
  return {
    digest: state.plugin?.package?.digest ?? null,
    moduleGeneration: state.plugin?.package?.moduleGeneration ?? null,
    activationDigest: state.activation?.digest ?? null,
    activationModuleGeneration: state.activation?.moduleGeneration ?? null,
    runtimeGeneration: state.runtimeGeneration,
    lifecycleRevision: state.lifecycleRevision,
    activationLastGoodRevision: state.activationLastGoodRevision,
    configRevision: state.configRevision,
    configLastGoodRevision: state.configLastGoodRevision,
  }
}
