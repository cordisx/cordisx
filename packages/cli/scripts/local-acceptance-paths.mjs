import { execFileSync } from 'node:child_process'
import { access, chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const LOCAL_ACCEPTANCE_MARKER = '.cordisx-local-acceptance-owner.json'
export const LOCAL_ACCEPTANCE_SCHEMA = 'cordisx.local-acceptance-owned-root/v1'
export const TEMP_ACCEPTANCE_PREFIX = 'cordisx-local-acceptance-'

const AUTHENTICATION_BASENAMES = new Set([
  'auth.json',
  'credentials.json',
  'grants.json',
  'token.json',
  'tokens.json',
])

export function pathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function assertNoAuthenticationMaterial(paths) {
  for (const target of paths) {
    const segments = path.normalize(target).split(path.sep).filter(Boolean)
    if (
      segments.some(segment => AUTHENTICATION_BASENAMES.has(segment.toLowerCase()))
      || segments.some(segment => /^(?:credential|grant|token)s?$/iu.test(segment))
    ) {
      throw new Error(`authentication material is not allowed in local acceptance inputs: ${path.basename(target)}`)
    }
  }
}

async function marker(root) {
  return JSON.parse(await readFile(path.join(root, LOCAL_ACCEPTANCE_MARKER), 'utf8'))
}

async function assertManagedRoot(root) {
  const resolved = path.resolve(root)
  const metadata = await lstat(resolved)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('local acceptance cleanup refused a non-directory or symbolic-link root')
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error('local acceptance cleanup refused a foreign-owned root')
  }
  const ownership = await marker(resolved).catch(error => {
    if (error?.code === 'ENOENT') throw new Error('local acceptance cleanup refused an unmarked root')
    throw error
  })
  if (ownership?.schema !== LOCAL_ACCEPTANCE_SCHEMA || ownership?.purpose !== 'local-candidate-acceptance') {
    throw new Error('local acceptance cleanup refused an invalid ownership marker')
  }
  if ([path.parse(resolved).root, path.resolve(os.homedir())].includes(resolved)) {
    throw new Error('local acceptance cleanup refused a protected root')
  }
  return { resolved, ownership }
}

function activeProfileProcesses(root) {
  if (process.platform === 'win32') return []
  const profile = path.join(root, 'chromium-profile')
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    return match !== null && match[2].includes(profile) ? [{ pid: Number(match[1]), command: match[2] }] : []
  })
}

export async function prepareAcceptanceProfile(profileRoot) {
  const temporary = profileRoot === undefined
  const root = temporary
    ? await mkdtemp(path.join(os.tmpdir(), TEMP_ACCEPTANCE_PREFIX))
    : path.resolve(profileRoot)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const metadata = await lstat(root)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('local acceptance profile must be a real directory')
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error('local acceptance profile must be owned by the current user')
  }
  await chmod(root, 0o700)
  const existingMarker = await readFile(path.join(root, LOCAL_ACCEPTANCE_MARKER), 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (existingMarker !== undefined) {
    const parsed = JSON.parse(existingMarker)
    if (parsed?.schema !== LOCAL_ACCEPTANCE_SCHEMA || parsed?.purpose !== 'local-candidate-acceptance') {
      throw new Error('local acceptance profile has an invalid ownership marker')
    }
  } else {
    const entries = await readdir(root)
    if (entries.length > 0) throw new Error('persistent acceptance profile must be empty on first use')
    await writeFile(
      path.join(root, LOCAL_ACCEPTANCE_MARKER),
      `${JSON.stringify({ schema: LOCAL_ACCEPTANCE_SCHEMA, purpose: 'local-candidate-acceptance' }, null, 2)}\n`,
      { mode: 0o600 },
    )
  }
  return {
    root,
    temporary,
    cordisxHome: path.join(root, 'cordisx-home'),
    chromiumProfile: path.join(root, 'chromium-profile'),
    fixtureRoot: path.join(root, 'checkpoint-plugin'),
  }
}

export async function cleanupAcceptanceProfile(root) {
  if (root === undefined) return { requested: false, removed: false, exists: false }
  const managed = await assertManagedRoot(root)
  const active = activeProfileProcesses(managed.resolved)
  if (active.length > 0) {
    throw new Error(
      `local acceptance cleanup refused an active Chromium profile: ${active.map(item => item.pid).join(',')}`,
    )
  }
  await rm(managed.resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  const exists = await access(managed.resolved).then(() => true, error => {
    if (error?.code === 'ENOENT') return false
    throw error
  })
  if (exists) throw new Error(`local acceptance profile still exists after cleanup: ${managed.resolved}`)
  return { requested: true, removed: true, exists: false }
}

export function redactAcceptanceText(text, replacements) {
  let result = text
  for (const [target, replacement] of replacements) {
    if (typeof target !== 'string' || target.length === 0) continue
    result = result.split(target).join(replacement)
  }
  return result
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/giu, '[private-url]')
    .replace(/\b(?:127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\b/giu, '[private-address]')
    .replace(/\b(token|credential|authorization|password|secret)\s*[:=]\s*[^\s,;}]+/giu, '$1=[redacted]')
}

export function sanitizeAcceptanceReport(value, replacements = []) {
  if (typeof value === 'string') return redactAcceptanceText(value, replacements)
  if (Array.isArray(value)) return value.map(item => sanitizeAcceptanceReport(item, replacements))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeAcceptanceReport(item, replacements)]),
  )
}

export function acceptanceEnvironment(environment, cordisxHome) {
  const originalHome = environment.HOME ?? os.homedir()
  const codexHome = environment.CODEX_HOME ?? path.join(originalHome, '.codex')
  const filtered = Object.fromEntries(
    Object.entries({ ...environment, CORDISX_HOME: cordisxHome }).filter(([name]) =>
      name === 'CODEX_HOME'
      || !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|(?:API|ACCESS|PRIVATE|SESSION)_?KEY)/iu.test(name)
    ),
  )
  return {
    ...filtered,
    HOME: originalHome,
    CODEX_HOME: codexHome,
    CORDISX_HOME: cordisxHome,
    CORDISX_SKIP_BUILTIN_SKILL_DEPLOYMENT: '1',
  }
}
