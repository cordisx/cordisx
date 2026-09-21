import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { RELEASE_MANIFEST_SCHEMA, RELEASE_STATE_SCHEMA } from './release-manifest.mjs'
import { releasePackageDefinitions } from './release-packages.mjs'
import { verifyCandidateDirectory, writeCandidateRelease } from './ci-release-candidate.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const commit = 'a'.repeat(40)
const repository = 'cordisx/cordisx'
const version = '0.1.0-beta.21'
const tag = `v${version}`

function integrity(content) {
  return `sha512-${createHash('sha512').update(content).digest('base64')}`
}

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'cordisx-ci-candidate-test-'))
  const artifactRoot = path.join(directory, 'release-packages')
  mkdirSync(artifactRoot)
  const packageManifests = new Map()
  const packageReports = releasePackageDefinitions.map(definition => {
    const filename = `${definition.name}-${version}.tgz`
    const content = Buffer.from(`${definition.name}\n`)
    writeFileSync(path.join(artifactRoot, filename), content)
    packageManifests.set(definition.name, {
      name: definition.name,
      version,
      dependencies: { dependency: '1.0.0' },
      optionalDependencies: {},
      peerDependencies: {},
      bundledDependencies: [],
    })
    return { ...definition, version, filename, integrity: integrity(content) }
  })
  await writeCandidateRelease({
    directory,
    repository,
    commit,
    tag,
    packageReports,
    packageManifests,
    createdAt: '2026-09-21T00:00:00.000Z',
    gates: {
      requiredCi: [{
        name: 'Check / selected gates',
        status: 'PASSED',
        commitSha: commit,
        evidenceUrl: 'https://github.com/cordisx/cordisx/actions/runs/1',
      }],
      review: {
        status: 'APPROVED',
        commitSha: commit,
        actor: 'maintainer',
        evidenceUrl: 'https://github.com/cordisx/cordisx/pull/1',
      },
    },
  })
  return directory
}

test('candidate uses the canonical manifest, state, and package paths', async () => {
  const directory = await fixture()
  try {
    const loaded = await verifyCandidateDirectory({
      directory,
      expectedCommit: commit,
      expectedRepository: repository,
      expectedTag: tag,
    })
    assert.equal(loaded.manifest.schema, RELEASE_MANIFEST_SCHEMA)
    assert.equal(loaded.state.schema, RELEASE_STATE_SCHEMA)
    assert.equal(loaded.manifest.packages.length, 2)
    assert.ok(loaded.manifest.packages.every(pkg => pkg.tarball.sha512.length === 128))
    assert.equal(existsSync(path.join(directory, 'provenance.json')), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a new head cannot inherit a successful candidate from the old commit', async () => {
  const directory = await fixture()
  try {
    await assert.rejects(
      verifyCandidateDirectory({
        directory,
        expectedCommit: 'b'.repeat(40),
        expectedRepository: repository,
        expectedTag: tag,
      }),
      /commit SHA mismatch/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('candidate verification rejects changed tarball bytes and recovery state', async () => {
  const directory = await fixture()
  try {
    const manifest = JSON.parse(readFileSync(path.join(directory, 'release-manifest.json'), 'utf8'))
    writeFileSync(path.join(directory, 'release-packages', manifest.packages[0].tarball.file), 'tampered\n')
    await assert.rejects(
      verifyCandidateDirectory({ directory, expectedCommit: commit, expectedRepository: repository, expectedTag: tag }),
      /tarball size mismatch/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }

  const stateDirectory = await fixture()
  try {
    const stateFile = path.join(stateDirectory, 'release-state.json')
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    state.commitSha = 'b'.repeat(40)
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`)
    await assert.rejects(
      verifyCandidateDirectory({
        directory: stateDirectory,
        expectedCommit: commit,
        expectedRepository: repository,
        expectedTag: tag,
      }),
      /release state commit SHA mismatch/,
    )
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true })
  }
})

test('installed-package packing reuses both configured candidate tarballs', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cordisx-installed-candidate-test-'))
  try {
    const cordisx = path.join(directory, 'cordisx.tgz')
    const creator = path.join(directory, 'creator.tgz')
    writeFileSync(cordisx, 'host')
    writeFileSync(creator, 'creator')
    const moduleUrl = new URL('./installed-check-package-cache.mjs', import.meta.url).href
    const source = `
      import { packWorkspace } from ${JSON.stringify(moduleUrl)}
      console.log(await packWorkspace(process.cwd(), 'cordisx', process.cwd()))
      console.log(await packWorkspace(process.cwd(), 'create-cordisx-plugin', process.cwd()))
    `
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
      encoding: 'utf8',
      env: { ...process.env, CORDISX_TARBALL: cordisx, CORDISX_CREATOR_TARBALL: creator },
    }).trim().split('\n')
    assert.deepEqual(output, [cordisx, creator])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('workflow finalizes canonical candidates and persists publication recovery', () => {
  const check = readFileSync(path.join(root, '.github/workflows/check.yml'), 'utf8')
  const release = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
  assert.match(check, /max-parallel: 4/)
  assert.match(check, /name: release-packages-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/)
  assert.match(check, /path: \.release-cache\/release-packages/)
  assert.match(check, /installed:\n[\s\S]*needs: \[scope, prepare, package\]/)
  assert.match(check, /needs: \[scope, changed-quality, prepare, typecheck, tests, package, installed\]/)
  assert.ok(check.includes('.result == "success" or .result == "skipped"'))
  assert.match(check, /name: release-candidate-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/)
  assert.match(check, /path: \.release-cache\n[\s\S]*include-hidden-files: true/)
  assert.match(release, /head_sha=\$HEAD_SHA&event=push/)
  assert.match(release, /gh run watch "\$run_id"[\s\S]*--exit-status/)
  assert.match(release, /name: release-candidate-\$\{\{ github\.sha \}\}/)
  assert.match(release, /path: \.release-cache/)
  assert.match(release, /release-manifest\.mjs resume/)
  assert.match(release, /name: release-state-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}/)
  assert.match(release, /if: always\(\) && steps\.candidate_ready\.outputs\.ready == 'true'/)
  assert.match(release, /verify-workspace[\s\S]*--tag "\$GITHUB_REF_NAME"/)
  assert.doesNotMatch(release, /npm ci|npm run build|npm run test:release/)
  assert.doesNotMatch(
    readFileSync(path.join(root, 'scripts/ci-release-candidate.mjs'), 'utf8'),
    /ci-release-candidate\/v1/,
  )
})
