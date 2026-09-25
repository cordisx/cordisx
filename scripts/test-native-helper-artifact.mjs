import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  copyNativeResources,
  NATIVE_HELPER_ARCHITECTURES,
  NATIVE_HELPER_MANIFEST,
  NATIVE_HELPERS,
  NATIVE_RESOURCES,
  verifyNativeHelperArtifact,
  writeNativeHelperManifest,
} from '../packages/cli/scripts/native-helper-artifact.mjs'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const commit = 'a'.repeat(40)

function universalMachO() {
  const bytes = Buffer.alloc(48)
  bytes.writeUInt32BE(0xcafebabe, 0)
  bytes.writeUInt32BE(2, 4)
  bytes.writeUInt32BE(0x0100000c, 8)
  bytes.writeUInt32BE(0x01000007, 28)
  return bytes
}

function artifactFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cordisx-native-helper-test-'))
  const sourceRoot = path.join(root, 'source')
  const outputRoot = path.join(root, 'dist', 'native')
  for (const relative of [...new Set(Object.values(NATIVE_HELPERS).flat())]) {
    const file = path.join(sourceRoot, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${relative}\n`)
  }
  mkdirSync(path.join(sourceRoot, 'native'), { recursive: true })
  mkdirSync(outputRoot, { recursive: true })
  for (const name of NATIVE_RESOURCES) {
    writeFileSync(path.join(sourceRoot, 'native', name), `${name}\n`)
    writeFileSync(path.join(outputRoot, name), `${name}\n`)
  }
  for (const name of Object.keys(NATIVE_HELPERS)) {
    const file = path.join(outputRoot, name)
    writeFileSync(file, universalMachO())
    chmodSync(file, 0o755)
  }
  writeNativeHelperManifest(sourceRoot, outputRoot, commit)
  return { root, sourceRoot, outputRoot }
}

test('native helper artifact binds universal executables and resources to the exact source commit', () => {
  const fixture = artifactFixture()
  try {
    const manifest = verifyNativeHelperArtifact(fixture.sourceRoot, fixture.outputRoot, commit)
    assert.deepEqual(manifest.architectures, NATIVE_HELPER_ARCHITECTURES)
    assert.deepEqual(Object.keys(manifest.helpers).sort(), Object.keys(NATIVE_HELPERS).sort())
    assert.deepEqual(Object.keys(manifest.resources).sort(), [...NATIVE_RESOURCES].sort())
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('portable native resources are copied on non-macOS package builds', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cordisx-native-resource-test-'))
  try {
    const outputRoot = path.join(root, 'native')
    copyNativeResources(path.join(repositoryRoot, 'packages/cli'), outputRoot)
    for (const name of NATIVE_RESOURCES) {
      assert.deepEqual(
        readFileSync(path.join(outputRoot, name)),
        readFileSync(path.join(repositoryRoot, 'packages/cli/native', name)),
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('native helper artifact rejects stale source identity and changed packaged bytes', () => {
  const fixture = artifactFixture()
  try {
    assert.throws(
      () => verifyNativeHelperArtifact(fixture.sourceRoot, fixture.outputRoot, 'b'.repeat(40)),
      /source commit mismatch/,
    )
    writeFileSync(path.join(fixture.outputRoot, NATIVE_RESOURCES[0]), 'changed\n')
    assert.throws(
      () => verifyNativeHelperArtifact(fixture.sourceRoot, fixture.outputRoot, commit),
      /native resource digest mismatch/,
    )
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('native helper artifact rejects non-universal and non-executable helpers', () => {
  const fixture = artifactFixture()
  try {
    const helper = path.join(fixture.outputRoot, Object.keys(NATIVE_HELPERS)[0])
    chmodSync(helper, 0o644)
    assert.throws(
      () => verifyNativeHelperArtifact(fixture.sourceRoot, fixture.outputRoot, commit),
      /mode 0755/,
    )
    chmodSync(helper, 0o755)
    const bytes = readFileSync(helper)
    bytes.writeUInt32BE(1, 4)
    writeFileSync(helper, bytes)
    writeNativeHelperManifest(fixture.sourceRoot, fixture.outputRoot, commit)
    assert.throws(
      () => verifyNativeHelperArtifact(fixture.sourceRoot, fixture.outputRoot, commit),
      /not universal/,
    )
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('Check builds and transfers exact-head native helpers before Linux packaging', () => {
  const workflow = readFileSync(path.join(repositoryRoot, '.github/workflows/check.yml'), 'utf8')
  assert.match(workflow, /native-helpers:\n[\s\S]*runs-on: macos-/)
  assert.match(workflow, /native-helper-artifact\.mjs build[\s\S]*--source-commit "\$HEAD_SHA"/)
  assert.match(workflow, /tar -czf "\$RUNNER_TEMP\/native-helpers\.tgz" -C packages\/cli dist\/native/)
  assert.match(workflow, /name: native-helpers-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/)
  assert.match(workflow, /package:\n[\s\S]*needs: \[scope, prepare, native-helpers\]/)
  assert.match(workflow, /native-helper-artifact\.mjs verify[\s\S]*--source-commit "\$HEAD_SHA"/)
  assert.match(
    workflow,
    /needs: \[scope, changed-quality, prepare, native-helpers, typecheck, tests, package, installed\]/,
  )
})

test('normal CLI builds copy portable native resources and compile helpers only on macOS', () => {
  const source = readFileSync(path.join(repositoryRoot, 'packages/cli/scripts/build-shortcut-helper.mjs'), 'utf8')
  assert.match(source, /copyNativeResources\(sourceRoot, nativeOutput\)/)
  assert.match(source, /if \(process\.platform === 'darwin'\) \{[\s\S]*buildNativeHelperArtifact/)
})
