import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const schema = 'cordisx/npm-release-recovery/v1'
const nextActions = new Set(['upload', 'visibility', 'verification', 'clean-install', 'complete'])
const recoveryStages = ['upload', 'visibility', 'verification', 'clean-install']

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`release recovery ${label} is missing`)
}

export function assertReleaseRecoveryIdentity(actual, expected) {
  for (const field of ['tag', 'version', 'gitHead', 'registry', 'artifactSha512']) {
    if (actual[field] !== expected[field]) throw new Error(`release recovery ${field} mismatch`)
  }
  if (JSON.stringify(actual.packageIntegrities) !== JSON.stringify(expected.packageIntegrities)) {
    throw new Error('release recovery package integrity set mismatch')
  }
}

export function assertReleaseRecoveryPackage(metadata, packageName, state) {
  if (metadata?.version !== state.version) throw new Error(`${packageName} registry version mismatch`)
  if (metadata?.dist?.integrity !== state.packageIntegrities[packageName]) {
    throw new Error(`${packageName} registry tarball integrity mismatch`)
  }
  if (metadata.gitHead !== state.gitHead) throw new Error(`${packageName} registry gitHead mismatch`)
}

function validateState(state) {
  if (state?.schema !== schema) throw new Error('release recovery state schema mismatch')
  for (const field of ['runId', 'tag', 'version', 'gitHead', 'registry', 'artifactSha512']) {
    assertString(state[field], field)
  }
  if (!Number.isInteger(state.runAttempt) || state.runAttempt < 1) {
    throw new Error('release recovery run attempt must be a positive integer')
  }
  if (!Number.isInteger(state.phaseAttempt) || state.phaseAttempt < 0) {
    throw new Error('release recovery phase attempt must be a non-negative integer')
  }
  if (!Array.isArray(state.uploadedPackages) || state.uploadedPackages.some(name => typeof name !== 'string')) {
    throw new Error('release recovery uploaded packages are invalid')
  }
  if (!state.packageIntegrities || typeof state.packageIntegrities !== 'object') {
    throw new Error('release recovery package integrities are missing')
  }
  if (!nextActions.has(state.nextAction)) throw new Error('release recovery next action is invalid')
  return state
}

export function releaseRecoveryIdentity({
  tag,
  version,
  gitHead,
  registry,
  artifactSha512,
  packageIntegrities,
}) {
  const identity = { tag, version, gitHead, registry, artifactSha512, packageIntegrities }
  for (const field of ['tag', 'version', 'gitHead', 'registry', 'artifactSha512']) {
    assertString(identity[field], field)
  }
  if (!packageIntegrities || typeof packageIntegrities !== 'object') {
    throw new Error('release recovery package integrities are missing')
  }
  return identity
}

export function releaseRecoveryStages(nextAction) {
  if (!nextActions.has(nextAction)) throw new Error('release recovery next action is invalid')
  if (nextAction === 'complete') return []
  return recoveryStages.slice(recoveryStages.indexOf(nextAction))
}

export async function readPreparedArtifactIdentity(file, expected) {
  const metadata = JSON.parse(await readFile(file, 'utf8'))
  for (const field of ['tag', 'version', 'gitHead']) {
    if (metadata[field] !== expected[field]) throw new Error(`prepared release artifact ${field} mismatch`)
  }
  if (JSON.stringify(metadata.packages) !== JSON.stringify(expected.packages)) {
    throw new Error('prepared release artifact package set mismatch')
  }
  assertString(metadata.sha512, 'artifact sha512')
  return metadata.sha512
}

export async function loadReleaseRecoveryState(file, { identity, runId, runAttempt }) {
  let state
  try {
    state = validateState(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return {
      schema,
      runId,
      runAttempt,
      ...identity,
      phaseAttempt: 0,
      uploadedPackages: [],
      nextAction: 'upload',
    }
  }
  if (state.runId !== runId) throw new Error('release recovery run id mismatch')
  if (runAttempt < state.runAttempt) throw new Error('release recovery run attempt moved backwards')
  assertReleaseRecoveryIdentity(state, identity)
  return { ...state, runAttempt }
}

export async function readReleaseRecoveryState(file) {
  return validateState(JSON.parse(await readFile(file, 'utf8')))
}

export async function saveReleaseRecoveryState(file, state) {
  validateState(state)
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
  return state
}

export async function updateReleaseRecoveryState(file, state, update) {
  const uploadedPackages = update.uploadedPackages === undefined
    ? state.uploadedPackages
    : [...new Set(update.uploadedPackages)]
  return saveReleaseRecoveryState(
    file,
    validateState({
      ...state,
      ...update,
      uploadedPackages,
    }),
  )
}
