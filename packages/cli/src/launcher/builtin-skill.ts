import { createHash, randomBytes } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvedLaunchPlan } from '../adapters/contracts.js'

export const CORDISX_PLUGIN_DEVELOPMENT_SKILL_NAME = 'cordisx-plugin-development'
export const CORDISX_SKILL_MARKER_FILE = '.cordisx-managed.json'

const CORDISX_SKILL_MARKER_CONTRACT = 'cordisx.skill-installation/v1'
const CORDISX_SKILL_DEPLOYMENT_LOCK_TIMEOUT_MS = 10_000
const CORDISX_SKILL_DEPLOYMENT_LOCK_RETRY_MS = 20
const REQUIRED_SKILL_FILES = [
  'SKILL.md',
  'agents/openai.yaml',
] as const

interface SkillFile {
  readonly relativePath: string
  readonly absolutePath: string
  readonly content: Buffer
}

interface SkillManifest {
  readonly files: readonly SkillFile[]
  readonly contentDigest: `sha256:${string}`
}

interface CordisXSkillMarkerV1 {
  readonly contract: typeof CORDISX_SKILL_MARKER_CONTRACT
  readonly schemaVersion: 1
  readonly managedBy: 'cordisx'
  readonly skillName: typeof CORDISX_PLUGIN_DEVELOPMENT_SKILL_NAME
  readonly contentDigest: `sha256:${string}`
}

export interface CordisXSkillDeploymentResult {
  readonly status: 'installed' | 'upgraded' | 'unchanged'
  readonly effectiveHome: string
  readonly targetDir: string
  readonly contentDigest: `sha256:${string}`
}

export interface DeployBundledCordisXSkillOptions {
  /** Repository-only override used by source-level tests and development. */
  readonly sourceDir?: string
  /** Repository-only test seam; product launches derive shared HOME from the resolved plan. */
  readonly sharedHomeOverride?: string
  /** Repository-only hooks for deterministic filesystem race tests. */
  readonly testHooks?: CordisXSkillDeploymentTestHooks
}

export type DeployBundledCordisXSkillToHomeOptions = Pick<
  DeployBundledCordisXSkillOptions,
  'sourceDir' | 'testHooks'
>

/** @internal Repository-only hooks; not part of the packaged CLI contract. */
export interface CordisXSkillDeploymentTestHooks {
  readonly afterLockAcquired?: () => void | Promise<void>
  readonly afterAdoptionMarkerWritten?: (markerPath: string) => void | Promise<void>
  readonly afterTargetMovedToBackup?: (backupDir: string) => void | Promise<void>
  readonly deploymentLockTimeoutMs?: number
}

export class CordisXSkillConflictError extends Error {
  constructor(readonly targetDir: string, detail: string) {
    super(
      `cannot install the built-in CordisX Skill because ${targetDir} ${detail}; `
      + 'the existing directory was left unchanged',
    )
    this.name = 'CordisXSkillConflictError'
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

async function realDirectory(directory: string): Promise<boolean> {
  return await lstat(directory).then(metadata => metadata.isDirectory()).catch(error => {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  })
}

async function collectSkillFiles(root: string, ignoreMarker: boolean): Promise<readonly SkillFile[]> {
  const files: SkillFile[] = []

  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const relativePath = relativeDirectory === ''
        ? entry.name
        : path.posix.join(relativeDirectory, entry.name)
      if (ignoreMarker && relativePath === CORDISX_SKILL_MARKER_FILE) continue
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath)
        continue
      }
      if (!entry.isFile()) {
        throw new Error(`CordisX Skill directories may contain only real directories and files: ${absolutePath}`)
      }
      files.push({ relativePath, absolutePath, content: await readFile(absolutePath) })
    }
  }

  await visit(root, '')
  return files
}

function digestSkillFiles(files: readonly SkillFile[]): `sha256:${string}` {
  const digest = createHash('sha256')
  for (const file of files) {
    const pathBytes = Buffer.from(file.relativePath, 'utf8')
    const pathLength = Buffer.allocUnsafe(8)
    const contentLength = Buffer.allocUnsafe(8)
    pathLength.writeBigUInt64BE(BigInt(pathBytes.length))
    contentLength.writeBigUInt64BE(BigInt(file.content.length))
    digest.update(pathLength)
    digest.update(pathBytes)
    digest.update(contentLength)
    digest.update(file.content)
  }
  return `sha256:${digest.digest('hex')}`
}

async function sourceManifest(sourceDir: string): Promise<SkillManifest> {
  const sourceMetadata = await lstat(sourceDir).catch(error => {
    throw new Error(`bundled CordisX Skill source is unavailable: ${sourceDir}`, { cause: error })
  })
  if (!sourceMetadata.isDirectory()) {
    throw new Error(`bundled CordisX Skill source must be a real directory: ${sourceDir}`)
  }
  const files = await collectSkillFiles(sourceDir, false)
  const names = new Set(files.map(file => file.relativePath))
  if (names.has(CORDISX_SKILL_MARKER_FILE)) {
    throw new Error(`bundled CordisX Skill source must not contain ${CORDISX_SKILL_MARKER_FILE}`)
  }
  for (const required of REQUIRED_SKILL_FILES) {
    if (!names.has(required)) throw new Error(`bundled CordisX Skill source is missing ${required}`)
  }
  return { files, contentDigest: digestSkillFiles(files) }
}

function parseMarker(raw: string): CordisXSkillMarkerV1 | undefined {
  try {
    const candidate = JSON.parse(raw) as Partial<CordisXSkillMarkerV1>
    if (
      candidate.contract !== CORDISX_SKILL_MARKER_CONTRACT
      || candidate.schemaVersion !== 1
      || candidate.managedBy !== 'cordisx'
      || candidate.skillName !== CORDISX_PLUGIN_DEVELOPMENT_SKILL_NAME
      || typeof candidate.contentDigest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/u.test(candidate.contentDigest)
    ) return undefined
    return candidate as CordisXSkillMarkerV1
  } catch {
    return undefined
  }
}

type ExistingTarget =
  | { readonly status: 'absent' }
  | { readonly status: 'unmanaged'; readonly contentDigest: `sha256:${string}` }
  | { readonly status: 'managed'; readonly contentDigest: `sha256:${string}` }

async function inspectExistingTarget(targetDir: string): Promise<ExistingTarget> {
  const metadata = await lstat(targetDir).catch(error => {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  })
  if (metadata === undefined) return { status: 'absent' }
  if (!metadata.isDirectory()) {
    throw new CordisXSkillConflictError(targetDir, 'already exists and is not a CordisX-managed directory')
  }

  const markerPath = path.join(targetDir, CORDISX_SKILL_MARKER_FILE)
  const markerSource = await readFile(markerPath, 'utf8').catch(error => {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  })
  if (markerSource === undefined) {
    try {
      return { status: 'unmanaged', contentDigest: digestSkillFiles(await collectSkillFiles(targetDir, true)) }
    } catch (error) {
      throw new CordisXSkillConflictError(
        targetDir,
        `cannot be adopted as an exact unmanaged Skill (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }
  const marker = parseMarker(markerSource)
  if (marker === undefined) throw new CordisXSkillConflictError(targetDir, 'has an invalid CordisX management marker')

  let files: readonly SkillFile[]
  try {
    files = await collectSkillFiles(targetDir, true)
  } catch (error) {
    throw new CordisXSkillConflictError(
      targetDir,
      `does not match its CordisX management marker (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  const actualDigest = digestSkillFiles(files)
  if (actualDigest !== marker.contentDigest) {
    throw new CordisXSkillConflictError(
      targetDir,
      `was changed after CordisX installed it (marker ${marker.contentDigest}, actual ${actualDigest})`,
    )
  }
  return { status: 'managed', contentDigest: actualDigest }
}

async function copyManifestToStage(manifest: SkillManifest, stageDir: string): Promise<void> {
  for (const file of manifest.files) {
    const destination = path.join(stageDir, ...file.relativePath.split('/'))
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(file.absolutePath, destination)
  }
  const marker: CordisXSkillMarkerV1 = {
    contract: CORDISX_SKILL_MARKER_CONTRACT,
    schemaVersion: 1,
    managedBy: 'cordisx',
    skillName: CORDISX_PLUGIN_DEVELOPMENT_SKILL_NAME,
    contentDigest: manifest.contentDigest,
  }
  await writeFile(
    path.join(stageDir, CORDISX_SKILL_MARKER_FILE),
    `${JSON.stringify(marker, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  )
}

async function adoptExactUnmanagedTarget(
  targetDir: string,
  expectedDigest: `sha256:${string}`,
  testHooks: CordisXSkillDeploymentTestHooks | undefined,
): Promise<void> {
  const markerPath = path.join(targetDir, CORDISX_SKILL_MARKER_FILE)
  const marker: CordisXSkillMarkerV1 = {
    contract: CORDISX_SKILL_MARKER_CONTRACT,
    schemaVersion: 1,
    managedBy: 'cordisx',
    skillName: CORDISX_PLUGIN_DEVELOPMENT_SKILL_NAME,
    contentDigest: expectedDigest,
  }
  const markerSource = `${JSON.stringify(marker, null, 2)}\n`
  const markerHandle = await open(markerPath, 'wx', 0o600)
  let markerIdentity: { readonly device: bigint; readonly inode: bigint }
  try {
    await markerHandle.writeFile(markerSource, 'utf8')
    await markerHandle.sync()
    const metadata = await markerHandle.stat({ bigint: true })
    markerIdentity = { device: metadata.dev, inode: metadata.ino }
  } finally {
    await markerHandle.close()
  }
  try {
    await testHooks?.afterAdoptionMarkerWritten?.(markerPath)
    await verifyStagedTarget(targetDir, expectedDigest)
  } catch (error) {
    await rollbackAdoptionMarker(targetDir, markerPath, markerSource, markerIdentity)
    throw new CordisXSkillConflictError(
      targetDir,
      `changed while CordisX was adopting its exact content (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

async function rollbackAdoptionMarker(
  targetDir: string,
  markerPath: string,
  expectedSource: string,
  expectedIdentity: { readonly device: bigint; readonly inode: bigint },
): Promise<void> {
  const rollbackPath = `${markerPath}.rollback-${randomBytes(12).toString('hex')}`
  try {
    await rename(markerPath, rollbackPath)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      throw new CordisXSkillConflictError(
        targetDir,
        'had its adoption marker removed concurrently',
      )
    }
    throw error
  }

  const restorePreservedMarker = async (detail: string): Promise<never> => {
    try {
      await rename(rollbackPath, markerPath)
    } catch (restoreError) {
      if (isNodeError(restoreError, 'EEXIST') || isNodeError(restoreError, 'ENOTEMPTY')) {
        throw new CordisXSkillConflictError(
          targetDir,
          `${detail}; the preserved marker remains at ${rollbackPath}`,
        )
      }
      throw new AggregateError(
        [new CordisXSkillConflictError(targetDir, detail), restoreError],
        `CordisX could not restore the concurrently changed adoption marker for ${targetDir}; `
        + `the preserved marker remains at ${rollbackPath}`,
      )
    }
    throw new CordisXSkillConflictError(targetDir, detail)
  }

  const metadata = await lstat(rollbackPath, { bigint: true })
  const source = await readFile(rollbackPath, 'utf8')
  if (
    !metadata.isFile()
    || metadata.dev !== expectedIdentity.device
    || metadata.ino !== expectedIdentity.inode
    || source !== expectedSource
  ) {
    await restorePreservedMarker('had its adoption marker changed concurrently')
  }
  await rm(rollbackPath)
}

async function verifyStagedTarget(stageDir: string, expectedDigest: string): Promise<void> {
  const staged = await inspectExistingTarget(stageDir)
  if (staged.status !== 'managed' || staged.contentDigest !== expectedDigest) {
    throw new Error(`staged CordisX Skill failed content verification: ${stageDir}`)
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function withSkillDeploymentLock<T>(
  skillsDir: string,
  testHooks: CordisXSkillDeploymentTestHooks | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(skillsDir, { recursive: true })
  const lockDir = path.join(skillsDir, `.${CORDISX_PLUGIN_DEVELOPMENT_SKILL_NAME}.deployment-lock`)
  const deadline = Date.now()
    + (testHooks?.deploymentLockTimeoutMs ?? CORDISX_SKILL_DEPLOYMENT_LOCK_TIMEOUT_MS)
  while (true) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error
      if (Date.now() >= deadline) {
        throw new CordisXSkillConflictError(
          path.join(skillsDir, CORDISX_PLUGIN_DEVELOPMENT_SKILL_NAME),
          'is currently being installed or upgraded by another CordisX process',
        )
      }
      await wait(CORDISX_SKILL_DEPLOYMENT_LOCK_RETRY_MS)
    }
  }

  try {
    await testHooks?.afterLockAcquired?.()
    return await operation()
  } finally {
    await rm(lockDir, { recursive: true, force: true })
  }
}

async function replaceManagedTarget(
  stageDir: string,
  targetDir: string,
  expectedExistingDigest: `sha256:${string}`,
  expectedDigest: `sha256:${string}`,
  testHooks: CordisXSkillDeploymentTestHooks | undefined,
): Promise<void> {
  const parent = path.dirname(targetDir)
  const backupDir = path.join(
    parent,
    `.${CORDISX_PLUGIN_DEVELOPMENT_SKILL_NAME}.backup-${randomBytes(12).toString('hex')}`,
  )
  await rename(targetDir, backupDir)
  try {
    await testHooks?.afterTargetMovedToBackup?.(backupDir)
    const captured = await inspectExistingTarget(backupDir)
    if (captured.status !== 'managed' || captured.contentDigest !== expectedExistingDigest) {
      throw new CordisXSkillConflictError(
        targetDir,
        'changed while CordisX was preparing its managed upgrade',
      )
    }
    await rename(stageDir, targetDir)
    await verifyStagedTarget(targetDir, expectedDigest)
  } catch (installError) {
    let rollbackError: unknown
    try {
      const targetExists = await lstat(targetDir).then(() => true).catch(error => {
        if (isNodeError(error, 'ENOENT')) return false
        throw error
      })
      if (targetExists) {
        throw new CordisXSkillConflictError(
          targetDir,
          `changed concurrently during an upgrade; its previous managed copy remains at ${backupDir}`,
        )
      }
      await rename(backupDir, targetDir)
    } catch (error) {
      rollbackError = error
    }
    if (rollbackError !== undefined) {
      if (rollbackError instanceof CordisXSkillConflictError) throw rollbackError
      throw new AggregateError(
        [installError, rollbackError],
        `CordisX Skill upgrade and rollback both failed for ${targetDir}`,
      )
    }
    throw installError
  }
  await rm(backupDir, { recursive: true, force: true })
}

async function bundledSkillSourceDir(): Promise<string> {
  const candidates = [
    fileURLToPath(new URL(`../../skills/${CORDISX_PLUGIN_DEVELOPMENT_SKILL_NAME}`, import.meta.url)),
    fileURLToPath(new URL(`../../../../skills/${CORDISX_PLUGIN_DEVELOPMENT_SKILL_NAME}`, import.meta.url)),
  ]
  for (const candidate of candidates) {
    if (await realDirectory(candidate)) return candidate
  }
  throw new Error(`bundled CordisX Skill source is unavailable; checked ${candidates.join(', ')}`)
}

function absoluteHome(candidate: string | undefined, label: string): string {
  if (candidate === undefined || candidate.trim() === '') {
    throw new Error(`resolved ${label} does not provide HOME for built-in Skill deployment`)
  }
  if (!path.isAbsolute(candidate)) {
    throw new Error(`resolved ${label} HOME must be an absolute path: ${candidate}`)
  }
  return path.resolve(candidate)
}

/** Keep CordisX profile selection, Chromium profiles, and official Codex configuration roots separate. */
export function effectiveHomeForCordisXSkill(
  plan: ResolvedLaunchPlan,
  sharedHomeOverride?: string,
): string {
  if (plan.dataMode === 'host-isolated') {
    return absoluteHome(plan.environment.HOME, 'host-isolated launch plan')
  }
  if (sharedHomeOverride !== undefined) return absoluteHome(sharedHomeOverride, 'shared launch test override')
  const sharedHome = plan.sharedDataRoots.find(root => root.name === 'HOME')?.path
  return absoluteHome(sharedHome, 'shared launch plan')
}

/** Deploy only CordisX's own built-in Skill, fully staged before the Host starts. */
export async function deployBundledCordisXSkillToHome(
  rawEffectiveHome: string,
  options: DeployBundledCordisXSkillToHomeOptions = {},
): Promise<CordisXSkillDeploymentResult> {
  const effectiveHome = absoluteHome(rawEffectiveHome, 'Host launch')
  const targetDir = path.join(effectiveHome, '.agents', 'skills', CORDISX_PLUGIN_DEVELOPMENT_SKILL_NAME)
  const sourceDir = path.resolve(options.sourceDir ?? await bundledSkillSourceDir())
  const manifest = await sourceManifest(sourceDir)
  const skillsDir = path.dirname(targetDir)
  return await withSkillDeploymentLock(skillsDir, options.testHooks, async () => {
    const existing = await inspectExistingTarget(targetDir)
    if (existing.status === 'managed' && existing.contentDigest === manifest.contentDigest) {
      return { status: 'unchanged', effectiveHome, targetDir, contentDigest: manifest.contentDigest }
    }
    if (existing.status === 'unmanaged') {
      if (existing.contentDigest !== manifest.contentDigest) {
        throw new CordisXSkillConflictError(targetDir, 'already exists with unmanaged or user-modified content')
      }
      try {
        await adoptExactUnmanagedTarget(targetDir, manifest.contentDigest, options.testHooks)
        return { status: 'unchanged', effectiveHome, targetDir, contentDigest: manifest.contentDigest }
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error
        const raced = await inspectExistingTarget(targetDir)
        if (raced.status === 'managed' && raced.contentDigest === manifest.contentDigest) {
          return { status: 'unchanged', effectiveHome, targetDir, contentDigest: manifest.contentDigest }
        }
        throw new CordisXSkillConflictError(targetDir, 'received a conflicting management marker concurrently')
      }
    }

    const stageDir = await mkdtemp(path.join(skillsDir, `.${CORDISX_PLUGIN_DEVELOPMENT_SKILL_NAME}.stage-`))
    let stageExists = true
    try {
      await copyManifestToStage(manifest, stageDir)
      await verifyStagedTarget(stageDir, manifest.contentDigest)
      if (existing.status === 'absent') {
        try {
          await rename(stageDir, targetDir)
          stageExists = false
          await verifyStagedTarget(targetDir, manifest.contentDigest)
          return { status: 'installed', effectiveHome, targetDir, contentDigest: manifest.contentDigest }
        } catch (error) {
          if (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'ENOTEMPTY')) throw error
          const raced = await inspectExistingTarget(targetDir)
          if (raced.status === 'managed' && raced.contentDigest === manifest.contentDigest) {
            return { status: 'unchanged', effectiveHome, targetDir, contentDigest: manifest.contentDigest }
          }
          throw new CordisXSkillConflictError(targetDir, 'was created concurrently with different content')
        }
      }

      await replaceManagedTarget(
        stageDir,
        targetDir,
        existing.contentDigest,
        manifest.contentDigest,
        options.testHooks,
      )
      stageExists = false
      return { status: 'upgraded', effectiveHome, targetDir, contentDigest: manifest.contentDigest }
    } finally {
      if (stageExists) await rm(stageDir, { recursive: true, force: true })
    }
  })
}

/** Resolve the named launch's Host HOME, then deploy only CordisX's own built-in Skill. */
export async function deployBundledCordisXSkill(
  plan: ResolvedLaunchPlan,
  options: DeployBundledCordisXSkillOptions = {},
): Promise<CordisXSkillDeploymentResult> {
  return await deployBundledCordisXSkillToHome(
    effectiveHomeForCordisXSkill(plan, options.sharedHomeOverride),
    options,
  )
}
