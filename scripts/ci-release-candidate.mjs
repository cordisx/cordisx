import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createReleaseManifest, createReleaseState, readReleaseFiles, writeReleaseFiles } from './release-manifest.mjs'
import { npmPackItem } from './npm-pack-report.mjs'
import { releasePackageDefinitions } from './release-packages.mjs'
import { releaseFromTag } from './release-version.mjs'

const execute = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

function assertText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`release candidate ${label} is missing`)
}

function releasePaths(directory) {
  return {
    manifestFile: path.join(directory, 'release-manifest.json'),
    stateFile: path.join(directory, 'release-state.json'),
    artifactRoot: path.join(directory, 'release-packages'),
  }
}

function packageDependencies(manifest) {
  return {
    runtime: manifest.dependencies ?? {},
    optional: manifest.optionalDependencies ?? {},
    peer: manifest.peerDependencies ?? {},
    bundled: manifest.bundledDependencies ?? manifest.bundleDependencies ?? [],
  }
}

function packageFilename(name, version) {
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`
}

async function fileIntegrity(file) {
  return `sha512-${createHash('sha512').update(await readFile(file)).digest('base64')}`
}

async function readPackageManifests() {
  return new Map(
    await Promise.all(releasePackageDefinitions.map(async definition => [
      definition.name,
      JSON.parse(await readFile(path.join(repositoryRoot, definition.directory, 'package.json'), 'utf8')),
    ])),
  )
}

function assertPackageSet(packages) {
  if (!Array.isArray(packages) || packages.length !== releasePackageDefinitions.length) {
    throw new Error('release candidate package set mismatch')
  }
  for (const [index, definition] of releasePackageDefinitions.entries()) {
    if (packages[index]?.name !== definition.name) throw new Error('release candidate package set mismatch')
  }
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

export async function packCandidatePackages(directory) {
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  const reports = []
  for (const definition of releasePackageDefinitions) reports.push(await packWorkspace(definition, directory))
  return reports
}

async function candidatePackageReports(artifactRoot, packageManifests) {
  const reports = []
  for (const definition of releasePackageDefinitions) {
    const manifest = packageManifests.get(definition.name)
    if (manifest === undefined) throw new Error(`release candidate package manifest is missing for ${definition.name}`)
    const filename = packageFilename(definition.name, manifest.version)
    reports.push({
      ...definition,
      version: manifest.version,
      filename,
      integrity: await fileIntegrity(path.join(artifactRoot, filename)),
    })
  }
  return reports
}

export async function writeCandidateRelease({
  directory,
  repository,
  commit,
  tag,
  registry = 'https://registry.npmjs.org',
  gates,
  packageReports,
  packageManifests,
  createdAt,
}) {
  assertText(repository, 'repository')
  assertText(commit, 'commit')
  assertText(tag, 'tag')
  assertPackageSet(packageReports)
  const release = releaseFromTag(tag)
  const { manifestFile, stateFile, artifactRoot } = releasePaths(directory)
  const packages = packageReports.map(report => {
    const manifest = packageManifests.get(report.name)
    if (manifest === undefined) throw new Error(`release candidate package manifest is missing for ${report.name}`)
    if (report.version !== release.version || manifest.version !== release.version) {
      throw new Error(`release candidate ${report.name} version mismatch`)
    }
    return {
      name: report.name,
      version: report.version,
      dependencies: packageDependencies(manifest),
      tarball: {
        path: path.join(artifactRoot, report.filename),
        integrity: report.integrity,
      },
    }
  })
  const manifest = await createReleaseManifest({
    createdAt,
    source: { repository, commitSha: commit, clean: true },
    release: { ...release, registry },
    packages,
    gates,
  })
  const state = createReleaseState(manifest, createdAt === undefined ? {} : { at: createdAt })
  await writeReleaseFiles({ manifestFile, stateFile, manifest, state })
  return { manifest, state }
}

export async function verifyCandidateDirectory({ directory, expectedCommit, expectedRepository, expectedTag }) {
  const paths = releasePaths(directory)
  const loaded = await readReleaseFiles({
    manifestFile: paths.manifestFile,
    stateFile: paths.stateFile,
    artifactRoot: paths.artifactRoot,
    commitSha: expectedCommit,
  })
  if (loaded.manifest.source.repository !== expectedRepository) {
    throw new Error('release candidate repository mismatch')
  }
  if (loaded.manifest.release.tag !== expectedTag) throw new Error('release candidate tag mismatch')
  assertPackageSet(loaded.manifest.packages)
  return loaded
}

async function createCandidate(directory, commit, repository, tag, gates) {
  const actualCommit = await command('git', ['rev-parse', 'HEAD'])
  if (actualCommit !== commit) throw new Error('release candidate checkout commit mismatch')
  const trackedChanges = await command('git', ['status', '--porcelain', '--untracked-files=no'])
  if (trackedChanges) throw new Error('release candidate creation requires a clean tracked working tree')
  const packageManifests = await readPackageManifests()
  const { artifactRoot } = releasePaths(directory)
  const packageReports = await candidatePackageReports(artifactRoot, packageManifests)
  return writeCandidateRelease({ directory, repository, commit, tag, gates, packageReports, packageManifests })
}

async function extractCandidate(directory, commit, repository, tag) {
  const loaded = await verifyCandidateDirectory({
    directory,
    expectedCommit: commit,
    expectedRepository: repository,
    expectedTag: tag,
  })
  const { artifactRoot } = releasePaths(directory)
  for (const pkg of loaded.manifest.packages) {
    const definition = releasePackageDefinitions.find(candidate => candidate.name === pkg.name)
    if (definition === undefined) throw new Error(`release candidate package is unsupported: ${pkg.name}`)
    await rm(path.join(repositoryRoot, definition.directory, 'dist'), { recursive: true, force: true })
    await rm(path.join(repositoryRoot, definition.directory, 'node_modules'), { recursive: true, force: true })
    await command('tar', [
      '-xzf',
      path.join(artifactRoot, pkg.tarball.file),
      '-C',
      path.join(repositoryRoot, definition.directory),
      '--strip-components=1',
    ])
  }
  return loaded
}

async function verifyWorkspace(directory, commit, repository, tag) {
  const loaded = await verifyCandidateDirectory({
    directory,
    expectedCommit: commit,
    expectedRepository: repository,
    expectedTag: tag,
  })
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-ci-candidate-'))
  try {
    const manifestPackages = new Map(loaded.manifest.packages.map(pkg => [pkg.name, pkg]))
    for (const definition of releasePackageDefinitions) {
      const report = await packWorkspace(definition, temporaryRoot)
      if (report.integrity !== manifestPackages.get(definition.name)?.tarball.integrity) {
        throw new Error(`release candidate ${definition.name} workspace integrity mismatch`)
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
  return loaded
}

function candidateGates(commit) {
  const reviewStatus = argument('--review-status')
  const review = {
    status: reviewStatus,
    commitSha: commit,
    actor: argument('--review-actor'),
    evidenceUrl: argument('--review-url'),
  }
  if (reviewStatus === 'BYPASSED') review.reason = argument('--review-reason')
  return {
    requiredCi: [{
      name: argument('--ci-name'),
      status: 'PASSED',
      commitSha: commit,
      evidenceUrl: argument('--ci-url'),
    }],
    review,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const operation = process.argv[2]
  const directory = argument('--directory')
  if (!directory || !['pack', 'create', 'verify', 'extract', 'verify-workspace'].includes(operation)) {
    throw new Error(
      'usage: ci-release-candidate.mjs pack|create|verify|extract|verify-workspace --directory <path>',
    )
  }
  const resolvedDirectory = path.resolve(directory)
  if (operation === 'pack') {
    const reports = await packCandidatePackages(resolvedDirectory)
    console.log(`[ci] packed ${reports.map(report => report.name).join(', ')}`)
  } else {
    const commit = argument('--commit')
    const repository = argument('--repository')
    const tag = argument('--tag')
    if (!commit || !repository || !tag) {
      throw new Error('release candidate operation requires --commit, --repository, and --tag')
    }
    const loaded = operation === 'create'
      ? await createCandidate(resolvedDirectory, commit, repository, tag, candidateGates(commit))
      : operation === 'extract'
      ? await extractCandidate(resolvedDirectory, commit, repository, tag)
      : operation === 'verify-workspace'
      ? await verifyWorkspace(resolvedDirectory, commit, repository, tag)
      : await verifyCandidateDirectory({
        directory: resolvedDirectory,
        expectedCommit: commit,
        expectedRepository: repository,
        expectedTag: tag,
      })
    console.log(`[ci] release candidate ${operation} verified for ${loaded.manifest.source.commitSha}`)
  }
}
