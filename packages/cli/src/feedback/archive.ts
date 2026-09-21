import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { type FeedbackArtifact, type FeedbackManifest } from './contracts.js'

const MAX_BUNDLE_BYTES = 10 * 1024 * 1024

export function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function safeRelativePath(value: string): boolean {
  return /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u.test(value) && !value.includes('\\')
}

export async function writePrivateFile(root: string, relativePath: string, content: string): Promise<FeedbackArtifact> {
  if (!safeRelativePath(relativePath)) throw new Error(`invalid feedback artifact path: ${relativePath}`)
  const target = path.join(root, ...relativePath.split('/'))
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  await writeFile(target, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await chmod(target, 0o600)
  const bytes = Buffer.byteLength(content)
  return {
    path: relativePath,
    purpose: '',
    evidenceType: 'environment_projection',
    status: 'present',
    bytes,
    sha256: sha256(content),
    redactions: 0,
  }
}

export async function makePrivateStage(parent: string, name: string): Promise<string> {
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const stage = path.join(parent, `.${name}.${process.pid}.${Date.now()}.tmp`)
  await mkdir(stage, { mode: 0o700 })
  return stage
}

export async function publishPrivateStage(stage: string, finalPath: string): Promise<void> {
  await rename(stage, finalPath)
  await chmod(finalPath, 0o700)
}

function isTextPath(relativePath: string): boolean {
  return /\.(?:json|jsonl|txt)$/u.test(relativePath)
}

function forbiddenText(text: string): boolean {
  return /(?:https?:\/\/|\bBearer\s+|(?:authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|password|credential)\s*[:=]|[A-Za-z]:[\\/]|\/(?:Users|home|private|tmp|var|opt|Applications)\/)/iu
    .test(text)
}

function isManifest(value: unknown): value is FeedbackManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const manifest = value as Record<string, unknown>
  if (
    !exactKeys(manifest, [
      'contract',
      'schemaVersion',
      'bundleId',
      'createdAt',
      'producer',
      'policy',
      'target',
      'selection',
      'limits',
      'artifacts',
      'exclusions',
      'missing',
      'redactions',
      'warnings',
      'archive',
    ])
  ) return false
  if (
    manifest.contract !== 'cordisx.feedback-manifest/v1' || manifest.schemaVersion !== 1
    || typeof manifest.bundleId !== 'string' || !/^fb_[a-z0-9]{12,64}$/u.test(manifest.bundleId)
    || !dateTime(manifest.createdAt)
  ) return false
  if (
    !producer(manifest.producer) || !policy(manifest.policy) || !target(manifest.target)
    || !selection(manifest.selection) || !limits(manifest.limits)
  ) return false
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length > 64 || !manifest.artifacts.every(artifact)) {
    return false
  }
  if (!Array.isArray(manifest.exclusions) || !manifest.exclusions.every(exclusion)) return false
  if (!Array.isArray(manifest.missing) || manifest.missing.length > 128 || !manifest.missing.every(missing)) {
    return false
  }
  if (
    !redactions(manifest.redactions) || !Array.isArray(manifest.warnings) || manifest.warnings.length > 128
    || !manifest.warnings.every(warning)
  ) return false
  return manifest.archive === undefined || archive(manifest.archive)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every(key => allowed.has(key))
}

function string(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit
}
function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
}
function dateTime(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 128 && Number.isFinite(Date.parse(value))
}

function producer(value: unknown): boolean {
  const item = record(value)
  return item !== undefined
    && exactKeys(item, ['cordisxVersion', 'nodeVersion', 'platform', 'osVersion', 'arch', 'hostVersion', 'hostBuild'])
    && string(item.cordisxVersion, 64) && string(item.nodeVersion, 64)
    && ['darwin', 'linux', 'win32', 'other'].includes(String(item.platform))
    && (item.osVersion === undefined || string(item.osVersion, 128)) && string(item.arch, 32)
    && (item.hostVersion === undefined || item.hostVersion === null || string(item.hostVersion, 128))
    && (item.hostBuild === undefined || item.hostBuild === null || string(item.hostBuild, 128))
}

function policy(value: unknown): boolean {
  const item = record(value)
  return item !== undefined && exactKeys(item, ['version', 'localOnly', 'contentCollection'])
    && string(item.version, 64) && item.localOnly === true && item.contentCollection === 'excluded'
}

function target(value: unknown): boolean {
  const item = record(value)
  const app = item === undefined ? undefined : record(item.app)
  const profile = item === undefined ? undefined : record(item.profile)
  return item !== undefined && app !== undefined && profile !== undefined
    && exactKeys(item, ['app', 'profile', 'dataMode'])
    && exactKeys(app, ['kind', 'ref']) && ['codex', 'other'].includes(String(app.kind))
    && (app.ref === undefined || /^app_[a-f0-9]{16,64}$/u.test(String(app.ref)))
    && exactKeys(profile, ['kind', 'ref']) && ['default', 'named'].includes(String(profile.kind))
    && /^profile_[a-f0-9]{16,64}$/u.test(String(profile.ref))
    && (item.dataMode === 'shared' || item.dataMode === 'host-isolated')
}

function selection(value: unknown): boolean {
  const item = record(value)
  return item !== undefined
    && exactKeys(item, ['launchId', 'from', 'until', 'correlationConfidence', 'disposition', 'cdpPort'])
    && (item.launchId === null || /^launch_[a-f0-9]{16,64}$/u.test(String(item.launchId))) && dateTime(item.from)
    && dateTime(item.until)
    && ['exact', 'partial', 'none'].includes(String(item.correlationConfidence))
    && ['ready', 'ready_then_cleanup_degraded', 'injection_failed', 'launch_failed', 'terminated', 'unknown'].includes(
      String(item.disposition),
    )
    && (item.cdpPort === null || integer(item.cdpPort, 1024, 65535))
}

function limits(value: unknown): boolean {
  const item = record(value)
  return item !== undefined && exactKeys(item, ['lookbackSeconds', 'maxBytes', 'maxEvents', 'collectionTimeoutMs'])
    && integer(item.lookbackSeconds, 1, 86400) && integer(item.maxBytes, 1, MAX_BUNDLE_BYTES)
    && integer(item.maxEvents, 1, 10000) && integer(item.collectionTimeoutMs, 1, 30000)
}

function artifact(value: unknown): boolean {
  const item = record(value)
  return item !== undefined
    && exactKeys(item, [
      'path',
      'purpose',
      'evidenceType',
      'status',
      'bytes',
      'sha256',
      'from',
      'until',
      'redactions',
      'omittedBytes',
    ])
    && typeof item.path === 'string' && safeRelativePath(item.path) && item.path.length <= 240
    && string(item.purpose, 240)
    && ['product_log', 'structured_event', 'environment_projection', 'user_report'].includes(String(item.evidenceType))
    && (item.status === 'present' || item.status === 'truncated') && integer(item.bytes, 0, MAX_BUNDLE_BYTES)
    && /^[a-f0-9]{64}$/u.test(String(item.sha256)) && integer(item.redactions, 0, Number.MAX_SAFE_INTEGER)
    && (item.from === undefined || dateTime(item.from)) && (item.until === undefined || dateTime(item.until))
    && (item.omittedBytes === undefined || integer(item.omittedBytes, 0, Number.MAX_SAFE_INTEGER))
}

function exclusion(value: unknown): boolean {
  const item = record(value)
  return item !== undefined && exactKeys(item, ['category', 'reason'])
    && [
      'conversation_content',
      'prompts',
      'credentials',
      'cookies',
      'complete_config',
      'complete_urls',
      'absolute_paths',
      'screenshots',
      'project_files',
      'browser_storage',
    ].includes(String(item.category))
    && string(item.reason, 240)
}

function missing(value: unknown): boolean {
  const item = record(value)
  return item !== undefined && exactKeys(item, ['field', 'status', 'reason'])
    && /^[a-z][a-z0-9._-]{0,127}$/u.test(String(item.field))
    && ['missing', 'unsupported', 'permission_denied', 'not_applicable', 'truncated'].includes(String(item.status))
    && string(item.reason, 500)
}

function redactions(value: unknown): boolean {
  const item = record(value)
  const categories = item === undefined ? undefined : record(item.byCategory)
  return item !== undefined && categories !== undefined && exactKeys(item, ['total', 'byCategory'])
    && integer(item.total, 0, Number.MAX_SAFE_INTEGER)
    && Object.entries(categories).every(([key, count]) =>
      /^[a-z][a-z0-9._-]{0,63}$/u.test(key) && integer(count, 0, Number.MAX_SAFE_INTEGER)
    )
}

function warning(value: unknown): boolean {
  const item = record(value)
  return item !== undefined && exactKeys(item, ['code', 'message'])
    && /^[a-z][a-z0-9._-]{0,63}$/u.test(String(item.code)) && string(item.message, 500)
}

function archive(value: unknown): boolean {
  const item = record(value)
  return item !== undefined && exactKeys(item, ['format', 'bytes', 'sha256', 'verified']) && item.format === 'zip'
    && integer(item.bytes, 1, MAX_BUNDLE_BYTES) && /^[a-f0-9]{64}$/u.test(String(item.sha256)) && item.verified === true
}

async function regularFile(target: string): Promise<void> {
  const metadata = await lstat(target)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`feedback bundle contains non-regular file: ${target}`)
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error(`feedback bundle file is not private: ${target}`)
  }
}

async function collectFiles(root: string, relative = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true })
  const output: string[] = []
  for (const entry of entries) {
    const child = relative === '' ? entry.name : path.posix.join(relative, entry.name)
    if (entry.isDirectory()) {
      const metadata = await lstat(path.join(root, child))
      if (metadata.isSymbolicLink() || (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)) {
        throw new Error(`feedback bundle directory is not private: ${child}`)
      }
      output.push(...await collectFiles(root, child))
    } else if (entry.isFile() && !entry.isSymbolicLink()) output.push(child)
    else throw new Error(`feedback bundle contains an unsafe entry: ${child}`)
  }
  return output.sort()
}

export async function inspectFeedbackBundle(root: string): Promise<FeedbackManifest> {
  const metadata = await lstat(root)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('feedback bundle must be a real directory')
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('feedback bundle directory is not private')
  }
  const manifestPath = path.join(root, 'manifest.json')
  await regularFile(manifestPath)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
  if (!isManifest(manifest)) throw new Error('feedback manifest is invalid')
  const inventory = new Map(manifest.artifacts.map(item => [item.path, item]))
  if (inventory.size !== manifest.artifacts.length) throw new Error('feedback manifest has duplicate artifacts')
  const expected = new Set(['manifest.json', ...inventory.keys()])
  const actual = new Set(await collectFiles(root))
  if (actual.size !== expected.size || [...actual].some(entry => !expected.has(entry))) {
    throw new Error('feedback bundle inventory does not match manifest')
  }
  let total = Buffer.byteLength(JSON.stringify(manifest))
  for (const artifact of manifest.artifacts) {
    if (!safeRelativePath(artifact.path)) throw new Error('feedback manifest has an unsafe artifact path')
    const target = path.join(root, ...artifact.path.split('/'))
    await regularFile(target)
    const contents = await readFile(target)
    total += contents.length
    if (contents.length !== artifact.bytes || sha256(contents) !== artifact.sha256) {
      throw new Error(`feedback artifact integrity check failed: ${artifact.path}`)
    }
    if (isTextPath(artifact.path) && forbiddenText(contents.toString('utf8'))) {
      throw new Error(`feedback artifact violates privacy policy: ${artifact.path}`)
    }
  }
  if (total > MAX_BUNDLE_BYTES || total > manifest.limits.maxBytes) {
    throw new Error('feedback bundle exceeds its byte limit')
  }
  return manifest
}

async function runCommand(command: string, args: readonly string[], cwd?: string): Promise<string> {
  const child = spawn(command, args, { ...(cwd === undefined ? {} : { cwd }), stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once(
      'exit',
      code =>
        code === 0
          ? resolve()
          : reject(new Error(`${command} failed: ${Buffer.concat(stderr).toString('utf8').trim()}`)),
    )
  })
  return Buffer.concat(stdout).toString('utf8')
}

export async function inspectFeedbackArchive(archivePath: string): Promise<FeedbackManifest> {
  await regularFile(archivePath)
  const entries = (await runCommand('unzip', ['-Z1', archivePath])).split(/\r?\n/u).filter(Boolean)
  const seen = new Set<string>()
  for (const entry of entries) {
    const normalized = entry.endsWith('/') ? entry.slice(0, -1) : entry
    if (normalized === '' || !safeRelativePath(normalized) || seen.has(entry)) {
      throw new Error('feedback archive contains an unsafe entry')
    }
    seen.add(entry)
  }
  const stage = await mkdtemp(path.join(os.tmpdir(), 'cordisx-feedback-inspect-'))
  try {
    await chmod(stage, 0o700)
    await runCommand('unzip', ['-qq', archivePath, '-d', stage])
    return await inspectFeedbackBundle(stage)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

async function runZip(root: string, archivePath: string): Promise<void> {
  await runCommand('zip', ['-q', '-r', archivePath, '.'], root)
}

export async function exportFeedbackBundle(
  root: string,
  output: string,
): Promise<{ readonly bytes: number; readonly sha256: string }> {
  await inspectFeedbackBundle(root)
  const resolvedOutput = path.resolve(output)
  if (path.extname(resolvedOutput) !== '.zip') throw new Error('feedback export output must end in .zip')
  const relativeOutput = path.relative(path.resolve(root), resolvedOutput)
  if (
    relativeOutput === ''
    || (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== '..' && !path.isAbsolute(relativeOutput))
  ) {
    throw new Error('feedback archive output must be outside the bundle directory')
  }
  await mkdir(path.dirname(resolvedOutput), { recursive: true, mode: 0o700 })
  const temporary = `${resolvedOutput}.${process.pid}.${Date.now()}.tmp`
  try {
    await runZip(root, temporary)
    await chmod(temporary, 0o600)
    const archive = await readFile(temporary)
    if (archive.length > MAX_BUNDLE_BYTES) throw new Error('feedback archive exceeds byte limit')
    await inspectFeedbackArchive(temporary)
    await rename(temporary, resolvedOutput)
    await chmod(resolvedOutput, 0o600)
    return { bytes: archive.length, sha256: sha256(archive) }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}
