import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { npmPackItem } from './npm-pack-report.mjs'
import { releasePackageDefinitions } from './release-packages.mjs'

const execute = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schema = 'cordisx/ci-release-candidate/v1'
const provenanceFilename = 'provenance.json'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function command(file, args, options = {}) {
  return (await execute(file, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })).stdout.trim()
}

async function fileIdentity(file) {
  const content = await readFile(file)
  const digest = createHash('sha512').update(content)
  return {
    size: (await stat(file)).size,
    sha512: digest.digest('hex'),
    integrity: `sha512-${createHash('sha512').update(content).digest('base64')}`,
  }
}

async function currentToolchain() {
  return { node: process.version, npm: await command('npm', ['--version']) }
}

function assertText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`release candidate ${label} is missing`)
}

function assertPackageSet(packages) {
  if (!Array.isArray(packages) || packages.length !== releasePackageDefinitions.length) {
    throw new Error('release candidate package set mismatch')
  }
  for (const [index, definition] of releasePackageDefinitions.entries()) {
    const pkg = packages[index]
    if (
      pkg?.name !== definition.name
      || pkg.workspace !== definition.workspace
      || pkg.directory !== definition.directory
    ) throw new Error('release candidate package set mismatch')
  }
}

export async function writeCandidateProvenance({ directory, repository, commit, toolchain, packageReports }) {
  assertText(repository, 'repository')
  assertText(commit, 'commit')
  assertText(toolchain?.node, 'Node toolchain')
  assertText(toolchain?.npm, 'npm toolchain')
  assertPackageSet(packageReports)
  const packages = []
  for (const [index, report] of packageReports.entries()) {
    const definition = releasePackageDefinitions[index]
    assertText(report.version, `${definition.name} version`)
    assertText(report.filename, `${definition.name} filename`)
    if (path.basename(report.filename) !== report.filename) {
      throw new Error(`release candidate ${definition.name} filename is unsafe`)
    }
    const identity = await fileIdentity(path.join(directory, report.filename))
    if (report.integrity !== undefined && report.integrity !== identity.integrity) {
      throw new Error(`release candidate ${definition.name} npm integrity mismatch`)
    }
    packages.push({
      name: definition.name,
      workspace: definition.workspace,
      directory: definition.directory,
      version: report.version,
      filename: report.filename,
      size: identity.size,
      sha512: identity.sha512,
      integrity: identity.integrity,
      shasum: report.shasum,
    })
  }
  const provenance = { schema, repository, commit, toolchain, packages }
  await writeFile(path.join(directory, provenanceFilename), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
  return provenance
}

export async function verifyCandidateDirectory({
  directory,
  expectedCommit,
  actualCommit = expectedCommit,
  expectedRepository,
  expectedToolchain,
}) {
  const provenance = JSON.parse(await readFile(path.join(directory, provenanceFilename), 'utf8'))
  if (provenance.schema !== schema) throw new Error('release candidate schema mismatch')
  if (provenance.commit !== expectedCommit) throw new Error('release candidate commit mismatch')
  if (actualCommit !== expectedCommit) throw new Error('release candidate checkout commit mismatch')
  if (expectedRepository !== undefined && provenance.repository !== expectedRepository) {
    throw new Error('release candidate repository mismatch')
  }
  assertText(provenance.toolchain?.node, 'Node toolchain')
  assertText(provenance.toolchain?.npm, 'npm toolchain')
  if (
    expectedToolchain !== undefined
    && (provenance.toolchain.node !== expectedToolchain.node || provenance.toolchain.npm !== expectedToolchain.npm)
  ) throw new Error('release candidate toolchain mismatch')
  assertPackageSet(provenance.packages)
  for (const pkg of provenance.packages) {
    if (path.basename(pkg.filename) !== pkg.filename) {
      throw new Error(`release candidate ${pkg.name} filename is unsafe`)
    }
    const identity = await fileIdentity(path.join(directory, pkg.filename))
    if (pkg.size !== identity.size) throw new Error(`release candidate ${pkg.name} size mismatch`)
    if (pkg.sha512 !== identity.sha512) throw new Error(`release candidate ${pkg.name} SHA-512 mismatch`)
    if (pkg.integrity !== identity.integrity) throw new Error(`release candidate ${pkg.name} integrity mismatch`)
  }
  return provenance
}

async function packWorkspace(definition, destination) {
  const report = JSON.parse(
    await command('npm', [
      'pack',
      `--workspace=${definition.workspace}`,
      '--ignore-scripts',
      '--pack-destination',
      destination,
      '--json',
    ]),
  )
  const item = npmPackItem(report, definition.name)
  if (item.name !== definition.name || typeof item.filename !== 'string') {
    throw new Error(`npm pack report is incomplete for ${definition.name}`)
  }
  return { ...definition, ...item }
}

async function createCandidate(directory, commit, repository) {
  const actualCommit = await command('git', ['rev-parse', 'HEAD'])
  if (actualCommit !== commit) throw new Error('release candidate checkout commit mismatch')
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  const packageReports = []
  for (const definition of releasePackageDefinitions) {
    packageReports.push(await packWorkspace(definition, directory))
  }
  return writeCandidateProvenance({
    directory,
    repository,
    commit,
    toolchain: await currentToolchain(),
    packageReports,
  })
}

async function verifyCandidate(directory, commit, repository, requireToolchain) {
  return verifyCandidateDirectory({
    directory,
    expectedCommit: commit,
    actualCommit: await command('git', ['rev-parse', 'HEAD']),
    expectedRepository: repository,
    expectedToolchain: requireToolchain ? await currentToolchain() : undefined,
  })
}

async function extractCandidate(directory, commit, repository, requireToolchain) {
  const provenance = await verifyCandidate(directory, commit, repository, requireToolchain)
  for (const pkg of provenance.packages) {
    await rm(path.join(repositoryRoot, pkg.directory, 'dist'), { recursive: true, force: true })
    await rm(path.join(repositoryRoot, pkg.directory, 'node_modules'), { recursive: true, force: true })
    await command('tar', [
      '-xzf',
      path.join(directory, pkg.filename),
      '-C',
      path.join(repositoryRoot, pkg.directory),
      '--strip-components=1',
    ])
  }
  return provenance
}

async function verifyWorkspace(directory, commit, repository, requireToolchain) {
  const provenance = await verifyCandidate(directory, commit, repository, requireToolchain)
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-ci-candidate-'))
  try {
    for (const [index, definition] of releasePackageDefinitions.entries()) {
      const report = await packWorkspace(definition, temporaryRoot)
      if (report.integrity !== provenance.packages[index].integrity) {
        throw new Error(`release candidate ${definition.name} workspace integrity mismatch`)
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
  return provenance
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const operation = process.argv[2]
  const directory = argument('--directory')
  const commit = argument('--commit')
  const repository = argument('--repository')
  const requireToolchain = process.argv.includes('--require-toolchain')
  if (
    !directory || !commit || !repository || !['create', 'verify', 'extract', 'verify-workspace'].includes(operation)
  ) {
    throw new Error(
      'usage: ci-release-candidate.mjs create|verify|extract|verify-workspace '
        + '--directory <path> --commit <sha> --repository <owner/repo> [--require-toolchain]',
    )
  }
  const resolvedDirectory = path.resolve(directory)
  const provenance = operation === 'create'
    ? await createCandidate(resolvedDirectory, commit, repository)
    : operation === 'extract'
    ? await extractCandidate(resolvedDirectory, commit, repository, requireToolchain)
    : operation === 'verify-workspace'
    ? await verifyWorkspace(resolvedDirectory, commit, repository, requireToolchain)
    : await verifyCandidate(resolvedDirectory, commit, repository, requireToolchain)
  console.log(`[ci] release candidate ${operation} verified for ${provenance.commit}`)
}
