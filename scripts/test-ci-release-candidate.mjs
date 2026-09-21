import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { verifyCandidateDirectory, writeCandidateProvenance } from './ci-release-candidate.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const commit = 'a'.repeat(40)
const repository = 'cordisx/cordisx'
const toolchain = { node: 'v24.0.0', npm: '11.11.0' }

function integrity(content) {
  return `sha512-${createHash('sha512').update(content).digest('base64')}`
}

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'cordisx-ci-candidate-test-'))
  const packages = [
    ['cordisx', 'cordisx', 'packages/cli', 'cordisx-0.1.0-beta.18.tgz'],
    [
      'create-cordisx-plugin',
      'create-cordisx-plugin',
      'packages/create-cordisx-plugin',
      'create-cordisx-plugin-0.1.0-beta.18.tgz',
    ],
  ].map(([name, workspace, packageDirectory, filename]) => {
    const content = Buffer.from(`${name}\n`)
    writeFileSync(path.join(directory, filename), content)
    return {
      name,
      workspace,
      directory: packageDirectory,
      version: '0.1.0-beta.18',
      filename,
      integrity: integrity(content),
      shasum: createHash('sha1').update(content).digest('hex'),
    }
  })
  await writeCandidateProvenance({ directory, repository, commit, toolchain, packageReports: packages })
  return directory
}

test('candidate provenance binds both tarballs to the exact commit and toolchain', async () => {
  const directory = await fixture()
  try {
    const provenance = await verifyCandidateDirectory({
      directory,
      expectedCommit: commit,
      expectedRepository: repository,
      expectedToolchain: toolchain,
    })
    assert.equal(provenance.packages.length, 2)
    assert.ok(provenance.packages.every(pkg => pkg.sha512.length === 128))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a new head cannot inherit a successful candidate from the old commit', async () => {
  const directory = await fixture()
  try {
    await assert.rejects(
      verifyCandidateDirectory({ directory, expectedCommit: 'b'.repeat(40), expectedRepository: repository }),
      /commit mismatch/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('candidate verification rejects archive tampering and toolchain drift', async () => {
  const directory = await fixture()
  try {
    const provenance = JSON.parse(readFileSync(path.join(directory, 'provenance.json'), 'utf8'))
    writeFileSync(path.join(directory, provenance.packages[0].filename), 'tampered\n')
    await assert.rejects(
      verifyCandidateDirectory({ directory, expectedCommit: commit, expectedRepository: repository }),
      /(?:size|SHA-512) mismatch/,
    )
    await assert.rejects(
      verifyCandidateDirectory({
        directory,
        expectedCommit: commit,
        expectedRepository: repository,
        expectedToolchain: { ...toolchain, npm: '12.0.0' },
      }),
      /toolchain mismatch/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
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

test('workflow keeps exact-SHA candidates, minimal reruns, and an all-green aggregate', () => {
  const check = readFileSync(path.join(root, '.github/workflows/check.yml'), 'utf8')
  const release = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
  assert.match(check, /max-parallel: 4/)
  assert.match(check, /name: release-candidate-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/)
  assert.match(check, /installed:\n[\s\S]*needs: \[scope, prepare, package\]/)
  assert.match(check, /needs: \[scope, changed-quality, prepare, typecheck, tests, package, installed\]/)
  assert.ok(check.includes('.result == "success" or .result == "skipped"'))
  assert.match(release, /head_sha=\$HEAD_SHA&event=push/)
  assert.match(release, /gh run watch "\$run_id"[\s\S]*--exit-status/)
  assert.match(release, /name: release-candidate-\$\{\{ github\.sha \}\}/)
  assert.match(release, /verify-workspace[\s\S]*--require-toolchain/)
  assert.doesNotMatch(release, /npm ci|npm run build|npm run test:release/)
})
