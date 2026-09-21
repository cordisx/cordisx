import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { releaseFromTag } from './release-version.mjs'

const execute = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const RELEASE_MANIFEST_SCHEMA = 'cordisx/release-manifest/v1'
export const RELEASE_STATE_SCHEMA = 'cordisx/release-state/v1'
export const RELEASE_PHASES = Object.freeze(['PUBLISHED', 'VISIBLE', 'VERIFIED', 'DISTRIBUTED'])

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertObject(value, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
}

function assertString(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label} must be a non-empty string`)
}

function assertCommitSha(value, label = 'commit SHA') {
  assertString(value, label)
  assert(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value), `${label} must be a full hexadecimal Git object ID`)
}

function assertTimestamp(value, label) {
  assertString(value, label)
  assert(!Number.isNaN(Date.parse(value)), `${label} must be an ISO timestamp`)
}

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalizeJson(value[key])]))
  }
  return value
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeJson(value))
}

export function releaseManifestDigest(manifest) {
  return `sha512-${createHash('sha512').update(canonicalJson(manifest)).digest('base64')}`
}

function fileDigests(contents) {
  const digest = createHash('sha512').update(contents)
  const base64 = digest.digest('base64')
  return {
    integrity: `sha512-${base64}`,
    sha512: createHash('sha512').update(contents).digest('hex'),
  }
}

function assertRegistry(registry) {
  let parsed
  try {
    parsed = new URL(registry)
  } catch (error) {
    throw new Error('release registry must be an absolute URL', { cause: error })
  }
  assert(parsed.protocol === 'https:', 'release registry must use HTTPS')
  assert(!parsed.username && !parsed.password, 'release registry must not contain credentials')
}

function assertDependencies(dependencies, label) {
  assertObject(dependencies, label)
  for (const [group, entries] of Object.entries(dependencies)) {
    if (group === 'bundled') {
      assert(
        Array.isArray(entries) && entries.every(value => typeof value === 'string'),
        `${label}.bundled must be strings`,
      )
      continue
    }
    assertObject(entries, `${label}.${group}`)
    for (const [name, version] of Object.entries(entries)) {
      assertString(name, `${label}.${group} dependency name`)
      assertString(version, `${label}.${group}.${name}`)
    }
  }
}

function assertGates(gates, commitSha) {
  assertObject(gates, 'release gates')
  assert(Array.isArray(gates.requiredCi) && gates.requiredCi.length > 0, 'release gates require CI evidence')
  const names = new Set()
  for (const gate of gates.requiredCi) {
    assertObject(gate, 'required CI gate')
    assertString(gate.name, 'required CI gate name')
    assert(!names.has(gate.name), `required CI gate ${gate.name} is duplicated`)
    names.add(gate.name)
    assert(gate.status === 'PASSED', `required CI gate ${gate.name} must be PASSED`)
    assert(gate.commitSha === commitSha, `required CI gate ${gate.name} commit SHA mismatch`)
    assertString(gate.evidenceUrl, `required CI gate ${gate.name} evidence URL`)
  }

  assertObject(gates.review, 'release review')
  assert(['APPROVED', 'BYPASSED'].includes(gates.review.status), 'release review must be APPROVED or BYPASSED')
  assert(gates.review.commitSha === commitSha, 'release review commit SHA mismatch')
  assertString(gates.review.actor, 'release review actor')
  assertString(gates.review.evidenceUrl, 'release review evidence URL')
  if (gates.review.status === 'BYPASSED') assertString(gates.review.reason, 'release review bypass reason')
}

export async function createReleaseManifest(input) {
  assertObject(input, 'release manifest input')
  assertObject(input.source, 'release source')
  assertCommitSha(input.source.commitSha)
  assert(input.source.clean === true, 'release source must have a clean tracked working tree')
  assertString(input.source.repository, 'release source repository')

  assertObject(input.release, 'release identity')
  const expectedRelease = releaseFromTag(input.release.tag)
  assert(input.release.version === expectedRelease.version, 'release version does not match tag')
  assert(input.release.distTag === expectedRelease.distTag, 'release dist-tag does not match tag')
  assertRegistry(input.release.registry)
  assertGates(input.gates, input.source.commitSha)
  assert(Array.isArray(input.packages) && input.packages.length > 0, 'release manifest requires packages')

  const names = new Set()
  const tarballFiles = new Set()
  const packages = []
  for (const pkg of input.packages) {
    assertObject(pkg, 'release package')
    assertString(pkg.name, 'release package name')
    assert(!names.has(pkg.name), `release package ${pkg.name} is duplicated`)
    names.add(pkg.name)
    assert(pkg.version === input.release.version, `${pkg.name} version does not match release version`)
    assertDependencies(pkg.dependencies, `${pkg.name} dependencies`)
    assertObject(pkg.tarball, `${pkg.name} tarball`)
    assertString(pkg.tarball.path, `${pkg.name} tarball path`)
    assertString(pkg.tarball.integrity, `${pkg.name} tarball integrity`)
    const contents = await readFile(pkg.tarball.path)
    const digests = fileDigests(contents)
    assert(pkg.tarball.integrity === digests.integrity, `${pkg.name} tarball integrity does not match its bytes`)
    const tarballFile = path.basename(pkg.tarball.path)
    assert(!tarballFiles.has(tarballFile), `release tarball ${tarballFile} is duplicated`)
    tarballFiles.add(tarballFile)
    packages.push({
      name: pkg.name,
      version: pkg.version,
      dependencies: normalizeJson(pkg.dependencies),
      tarball: {
        file: tarballFile,
        size: contents.byteLength,
        sha512: digests.sha512,
        integrity: digests.integrity,
      },
    })
  }

  return {
    schema: RELEASE_MANIFEST_SCHEMA,
    createdAt: input.createdAt ?? new Date().toISOString(),
    source: {
      repository: input.source.repository,
      commitSha: input.source.commitSha,
      clean: true,
    },
    release: {
      tag: expectedRelease.tag,
      version: expectedRelease.version,
      registry: input.release.registry,
      distTag: expectedRelease.distTag,
    },
    packages,
    gates: normalizeJson(input.gates),
    lifecycle: { phases: [...RELEASE_PHASES] },
  }
}

export async function verifyReleaseManifest(manifest, options = {}) {
  assertObject(manifest, 'release manifest')
  assert(manifest.schema === RELEASE_MANIFEST_SCHEMA, 'release manifest schema mismatch')
  assertTimestamp(manifest.createdAt, 'release manifest creation time')
  assertObject(manifest.source, 'release source')
  assertCommitSha(manifest.source.commitSha)
  assert(manifest.source.clean === true, 'release manifest source is not clean')
  assertString(manifest.source.repository, 'release source repository')
  if (options.commitSha !== undefined) {
    assert(manifest.source.commitSha === options.commitSha, 'release manifest commit SHA mismatch')
  }
  assertObject(manifest.release, 'release identity')
  const release = releaseFromTag(manifest.release.tag)
  assert(manifest.release.version === release.version, 'release manifest version mismatch')
  assert(manifest.release.distTag === release.distTag, 'release manifest dist-tag mismatch')
  assertRegistry(manifest.release.registry)
  assertGates(manifest.gates, manifest.source.commitSha)
  assert(
    JSON.stringify(manifest.lifecycle?.phases) === JSON.stringify(RELEASE_PHASES),
    'release manifest lifecycle phases mismatch',
  )
  assert(Array.isArray(manifest.packages) && manifest.packages.length > 0, 'release manifest packages are missing')

  const artifactRoot = options.artifactRoot
  const names = new Set()
  const tarballFiles = new Set()
  for (const pkg of manifest.packages) {
    assertString(pkg.name, 'release package name')
    assert(!names.has(pkg.name), `release package ${pkg.name} is duplicated`)
    names.add(pkg.name)
    assert(pkg.version === release.version, `${pkg.name} version does not match release version`)
    assertDependencies(pkg.dependencies, `${pkg.name} dependencies`)
    assertObject(pkg.tarball, `${pkg.name} tarball`)
    assertString(pkg.tarball.file, `${pkg.name} tarball file`)
    assert(path.basename(pkg.tarball.file) === pkg.tarball.file, `${pkg.name} tarball file must be a basename`)
    assert(!tarballFiles.has(pkg.tarball.file), `release tarball ${pkg.tarball.file} is duplicated`)
    tarballFiles.add(pkg.tarball.file)
    assert(Number.isSafeInteger(pkg.tarball.size) && pkg.tarball.size >= 0, `${pkg.name} tarball size is invalid`)
    assert(/^[0-9a-f]{128}$/.test(pkg.tarball.sha512), `${pkg.name} tarball SHA-512 is invalid`)
    assert(/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(pkg.tarball.integrity), `${pkg.name} tarball integrity is invalid`)
    if (artifactRoot !== undefined) {
      const contents = await readFile(path.join(artifactRoot, pkg.tarball.file))
      const digests = fileDigests(contents)
      assert(contents.byteLength === pkg.tarball.size, `${pkg.name} tarball size mismatch`)
      assert(digests.sha512 === pkg.tarball.sha512, `${pkg.name} tarball SHA-512 mismatch`)
      assert(digests.integrity === pkg.tarball.integrity, `${pkg.name} tarball integrity mismatch`)
    }
  }
  return manifest
}

export function createReleaseState(manifest, options = {}) {
  const at = options.at ?? new Date().toISOString()
  return {
    schema: RELEASE_STATE_SCHEMA,
    manifestDigest: releaseManifestDigest(manifest),
    commitSha: manifest.source.commitSha,
    phases: Object.fromEntries(RELEASE_PHASES.map(phase => [phase, { status: 'PENDING' }])),
    recovery: { checkpoint: 'PREPARED', nextPhase: RELEASE_PHASES[0] },
    updatedAt: at,
  }
}

export function verifyReleaseState(state, manifest, options = {}) {
  assertObject(state, 'release state')
  assert(state.schema === RELEASE_STATE_SCHEMA, 'release state schema mismatch')
  assert(state.commitSha === manifest.source.commitSha, 'release state commit SHA mismatch')
  if (options.commitSha !== undefined) {
    assert(state.commitSha === options.commitSha, 'release state does not belong to the checked-out commit')
  }
  assert(state.manifestDigest === releaseManifestDigest(manifest), 'release state manifest digest mismatch')
  assertObject(state.phases, 'release phases')
  assert(
    JSON.stringify(Object.keys(state.phases).sort()) === JSON.stringify([...RELEASE_PHASES].sort()),
    'release state phase set mismatch',
  )
  assertTimestamp(state.updatedAt, 'release state update time')

  let pendingSeen = false
  let checkpoint = 'PREPARED'
  let nextPhase = null
  for (const phase of RELEASE_PHASES) {
    const entry = state.phases[phase]
    assertObject(entry, `release phase ${phase}`)
    assert(['PENDING', 'COMPLETE'].includes(entry.status), `release phase ${phase} status is invalid`)
    if (entry.status === 'COMPLETE') {
      assert(!pendingSeen, `release phase ${phase} cannot complete before its prerequisite`)
      assertTimestamp(entry.completedAt, `release phase ${phase} completion time`)
      assertObject(entry.evidence, `release phase ${phase} evidence`)
      checkpoint = phase
    } else {
      pendingSeen = true
      if (nextPhase === null) nextPhase = phase
    }
  }
  assert(state.recovery?.checkpoint === checkpoint, 'release recovery checkpoint mismatch')
  assert(state.recovery?.nextPhase === nextPhase, 'release recovery next phase mismatch')
  return { checkpoint, nextPhase, complete: nextPhase === null }
}

export function advanceReleaseState(state, manifest, phase, evidence, options = {}) {
  const recovery = verifyReleaseState(state, manifest, options)
  assert(RELEASE_PHASES.includes(phase), `unknown release phase ${phase}`)
  if (state.phases[phase].status === 'COMPLETE') return state
  assertObject(evidence, `release phase ${phase} evidence`)
  const expectedPackages = manifest.packages.map(pkg => pkg.name).sort()
  assert(Array.isArray(evidence.packages), `release phase ${phase} evidence must list packages`)
  assert(new Set(evidence.packages).size === evidence.packages.length, `release phase ${phase} evidence has duplicates`)
  assert(
    JSON.stringify([...new Set(evidence.packages)].sort()) === JSON.stringify(expectedPackages),
    `release phase ${phase} evidence must cover the complete package set`,
  )
  assert(recovery.nextPhase === phase, `release phase ${phase} cannot run before ${recovery.nextPhase}`)

  const next = structuredClone(state)
  next.phases[phase] = {
    status: 'COMPLETE',
    completedAt: options.at ?? new Date().toISOString(),
    evidence: normalizeJson(evidence),
  }
  const index = RELEASE_PHASES.indexOf(phase)
  next.recovery = {
    checkpoint: phase,
    nextPhase: RELEASE_PHASES[index + 1] ?? null,
  }
  next.updatedAt = options.at ?? new Date().toISOString()
  return next
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

async function writeJsonExclusive(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
}

export async function writeReleaseFiles({ manifestFile, stateFile, manifest, state }) {
  await writeJsonExclusive(manifestFile, manifest)
  try {
    await writeJsonExclusive(stateFile, state)
  } catch (error) {
    await unlink(manifestFile)
    throw error
  }
}

export async function readReleaseFiles({ manifestFile, stateFile, artifactRoot, commitSha }) {
  const [manifest, state] = await Promise.all([
    readFile(manifestFile, 'utf8').then(JSON.parse),
    readFile(stateFile, 'utf8').then(JSON.parse),
  ])
  await verifyReleaseManifest(manifest, { artifactRoot, commitSha })
  const recovery = verifyReleaseState(state, manifest, { commitSha })
  return { manifest, state, recovery }
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function git(...args) {
  return (await execute('git', args, { cwd: repositoryRoot, encoding: 'utf8' })).stdout.trim()
}

async function runCli() {
  const operation = process.argv[2]
  const manifestFile = argument('--manifest')
  const stateFile = argument('--state')
  if (!manifestFile || !stateFile || !['create', 'verify', 'advance', 'resume'].includes(operation)) {
    throw new Error(
      'usage: release-manifest.mjs create|verify|advance|resume --manifest <path> --state <path>',
    )
  }
  const commitSha = await git('rev-parse', 'HEAD')
  if (operation === 'create') {
    const inputFile = argument('--input')
    if (!inputFile) throw new Error('release manifest creation requires --input <path>')
    const trackedChanges = await git('status', '--porcelain', '--untracked-files=no')
    if (trackedChanges) throw new Error('release manifest creation requires a clean tracked working tree')
    const input = JSON.parse(await readFile(inputFile, 'utf8'))
    input.source = { ...input.source, commitSha, clean: true }
    const manifest = await createReleaseManifest(input)
    const state = createReleaseState(manifest)
    await writeReleaseFiles({ manifestFile, stateFile, manifest, state })
    console.log(JSON.stringify({ manifestDigest: releaseManifestDigest(manifest), ...state.recovery }))
    return
  }

  const artifactRoot = argument('--artifact-root')
  if (!artifactRoot) throw new Error('release manifest verification requires --artifact-root <path>')
  const loaded = await readReleaseFiles({ manifestFile, stateFile, artifactRoot, commitSha })
  if (operation === 'advance') {
    const phase = argument('--phase')
    const evidenceFile = argument('--evidence')
    if (!phase || !evidenceFile) throw new Error('release state advance requires --phase and --evidence')
    const evidence = JSON.parse(await readFile(evidenceFile, 'utf8'))
    const state = advanceReleaseState(loaded.state, loaded.manifest, phase, evidence, { commitSha })
    await writeJsonAtomic(stateFile, state)
    console.log(JSON.stringify(state.recovery))
    return
  }
  console.log(JSON.stringify(loaded.recovery))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runCli()
