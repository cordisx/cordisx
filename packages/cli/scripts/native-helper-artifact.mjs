import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const NATIVE_HELPER_ARTIFACT_SCHEMA = 'cordisx/native-helper-artifact/v1'
export const NATIVE_HELPER_ARCHITECTURES = ['arm64', 'x64']
export const NATIVE_HELPER_DEPLOYMENT_TARGET = '13.0'
export const NATIVE_HELPERS = {
  CordisXEntry: [
    'native/shortcut-helper/Images.swift',
    'native/shortcut-helper/Runner.swift',
    'native/shortcut-helper/Entry.swift',
    'native/shortcut-helper/main.swift',
  ],
  CordisXHostOpen: ['native/host-open.swift'],
  CordisXLauncher: ['native/app-launcher.swift'],
  CordisXStartupGate: ['native/startup-gate.swift'],
}
export const NATIVE_RESOURCES = [
  'dock-agent.cjs',
  'startup-cover.cjs',
  'startup-cover.css',
  'startup-loading.html',
  'startup-navigation.cjs',
  'visibility-agent.cjs',
]
export const NATIVE_HELPER_MANIFEST = 'native-helper-artifact.json'

const architectureTargets = { arm64: 'arm64', x64: 'x86_64' }
const machOCpuTypes = new Map([[0x0100000c, 'arm64'], [0x01000007, 'x64']])

function sha256(file) {
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`
}

function assertCommit(commit) {
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error('native helper artifact source commit must be an exact Git SHA')
  }
}

function nativeSource(sourceRoot, relative) {
  return path.join(sourceRoot, relative)
}

export function copyNativeResources(sourceRoot, outputRoot) {
  mkdirSync(outputRoot, { recursive: true })
  for (const name of NATIVE_RESOURCES) {
    copyFileSync(nativeSource(sourceRoot, `native/${name}`), path.join(outputRoot, name))
  }
}

export function machOArchitectures(file) {
  const bytes = readFileSync(file)
  if (bytes.length < 8) throw new Error(`native helper is not a universal Mach-O executable: ${path.basename(file)}`)
  const magic = bytes.readUInt32BE(0)
  const recordSize = magic === 0xcafebabe ? 20 : magic === 0xcafebabf ? 32 : 0
  if (recordSize === 0) throw new Error(`native helper is not a universal Mach-O executable: ${path.basename(file)}`)
  const count = bytes.readUInt32BE(4)
  if (count === 0 || 8 + count * recordSize > bytes.length) {
    throw new Error(`native helper has an invalid universal Mach-O header: ${path.basename(file)}`)
  }
  const architectures = []
  for (let index = 0; index < count; index += 1) {
    const cpuType = bytes.readUInt32BE(8 + index * recordSize)
    const architecture = machOCpuTypes.get(cpuType)
    if (architecture === undefined) {
      throw new Error(`native helper has an unsupported Mach-O architecture: ${path.basename(file)}`)
    }
    architectures.push(architecture)
  }
  return [...new Set(architectures)].sort()
}

function sourceInputs(sourceRoot) {
  const inputs = {}
  for (const relative of [...new Set(Object.values(NATIVE_HELPERS).flat())].sort()) {
    inputs[relative] = sha256(nativeSource(sourceRoot, relative))
  }
  for (const name of NATIVE_RESOURCES) inputs[`native/${name}`] = sha256(nativeSource(sourceRoot, `native/${name}`))
  return inputs
}

export function writeNativeHelperManifest(sourceRoot, outputRoot, sourceCommit) {
  assertCommit(sourceCommit)
  const helpers = {}
  for (const name of Object.keys(NATIVE_HELPERS).sort()) {
    const file = path.join(outputRoot, name)
    helpers[name] = {
      sha256: sha256(file),
      mode: '0755',
      architectures: machOArchitectures(file),
    }
  }
  const resources = {}
  for (const name of NATIVE_RESOURCES) resources[name] = { sha256: sha256(path.join(outputRoot, name)) }
  const manifest = {
    schema: NATIVE_HELPER_ARTIFACT_SCHEMA,
    sourceCommit,
    deploymentTarget: NATIVE_HELPER_DEPLOYMENT_TARGET,
    architectures: NATIVE_HELPER_ARCHITECTURES,
    inputs: sourceInputs(sourceRoot),
    helpers,
    resources,
  }
  writeFileSync(path.join(outputRoot, NATIVE_HELPER_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export function buildNativeHelperArtifact(sourceRoot, outputRoot, sourceCommit) {
  if (process.platform !== 'darwin') throw new Error('native helper compilation requires macOS')
  copyNativeResources(sourceRoot, outputRoot)
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'cordisx-native-helpers-'))
  try {
    for (const [name, sources] of Object.entries(NATIVE_HELPERS)) {
      const slices = []
      for (const architecture of NATIVE_HELPER_ARCHITECTURES) {
        const slice = path.join(temporaryRoot, `${name}.${architecture}`)
        execFileSync('/usr/bin/swiftc', [
          '-O',
          '-target',
          `${architectureTargets[architecture]}-apple-macosx${NATIVE_HELPER_DEPLOYMENT_TARGET}`,
          ...sources.map(relative => nativeSource(sourceRoot, relative)),
          '-o',
          slice,
        ], { stdio: 'inherit' })
        slices.push(slice)
      }
      const output = path.join(outputRoot, name)
      execFileSync('/usr/bin/lipo', ['-create', ...slices, '-output', output], { stdio: 'inherit' })
      chmodSync(output, 0o755)
    }
    writeNativeHelperManifest(sourceRoot, outputRoot, sourceCommit)
    return verifyNativeHelperArtifact(sourceRoot, outputRoot, sourceCommit)
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} entries do not match the release contract`)
  }
}

export function verifyNativeHelperArtifact(sourceRoot, outputRoot, expectedCommit) {
  assertCommit(expectedCommit)
  const manifest = JSON.parse(readFileSync(path.join(outputRoot, NATIVE_HELPER_MANIFEST), 'utf8'))
  if (manifest.schema !== NATIVE_HELPER_ARTIFACT_SCHEMA) throw new Error('native helper artifact schema mismatch')
  if (manifest.sourceCommit !== expectedCommit) throw new Error('native helper artifact source commit mismatch')
  if (manifest.deploymentTarget !== NATIVE_HELPER_DEPLOYMENT_TARGET) {
    throw new Error('native helper artifact deployment target mismatch')
  }
  if (JSON.stringify(manifest.architectures) !== JSON.stringify(NATIVE_HELPER_ARCHITECTURES)) {
    throw new Error('native helper artifact architecture contract mismatch')
  }
  exactKeys(manifest.helpers, Object.keys(NATIVE_HELPERS), 'native helper')
  exactKeys(manifest.resources, NATIVE_RESOURCES, 'native resource')
  exactKeys(manifest.inputs, Object.keys(sourceInputs(sourceRoot)), 'native source input')
  for (const [relative, digest] of Object.entries(sourceInputs(sourceRoot))) {
    if (manifest.inputs[relative] !== digest) throw new Error(`native helper source input mismatch: ${relative}`)
  }
  for (const name of Object.keys(NATIVE_HELPERS)) {
    const file = path.join(outputRoot, name)
    const metadata = statSync(file)
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o755) {
      throw new Error(`native helper must be executable with mode 0755: ${name}`)
    }
    if (manifest.helpers[name]?.mode !== '0755') throw new Error(`native helper manifest mode mismatch: ${name}`)
    if (manifest.helpers[name]?.sha256 !== sha256(file)) throw new Error(`native helper digest mismatch: ${name}`)
    const architectures = machOArchitectures(file)
    if (JSON.stringify(architectures) !== JSON.stringify(NATIVE_HELPER_ARCHITECTURES)) {
      throw new Error(`native helper is not universal: ${name}`)
    }
    if (JSON.stringify(manifest.helpers[name]?.architectures) !== JSON.stringify(architectures)) {
      throw new Error(`native helper manifest architecture mismatch: ${name}`)
    }
  }
  for (const name of NATIVE_RESOURCES) {
    const file = path.join(outputRoot, name)
    if (!statSync(file).isFile()) throw new Error(`native resource is not a file: ${name}`)
    if (manifest.resources[name]?.sha256 !== sha256(file)) throw new Error(`native resource digest mismatch: ${name}`)
  }
  const expectedFiles = [...Object.keys(NATIVE_HELPERS), ...NATIVE_RESOURCES, NATIVE_HELPER_MANIFEST].sort()
  if (JSON.stringify(readdirSync(outputRoot).sort()) !== JSON.stringify(expectedFiles)) {
    throw new Error('native helper artifact contains unexpected or missing files')
  }
  return manifest
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const operation = process.argv[2]
  const sourceRoot = path.resolve(argument('--source-root') ?? fileURLToPath(new URL('..', import.meta.url)))
  const outputRoot = path.resolve(argument('--output') ?? path.join(sourceRoot, 'dist', 'native'))
  const sourceCommit = argument('--source-commit')
    ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
  if (operation === 'build') buildNativeHelperArtifact(sourceRoot, outputRoot, sourceCommit)
  else if (operation === 'verify') verifyNativeHelperArtifact(sourceRoot, outputRoot, sourceCommit)
  else {throw new Error(
      'Usage: native-helper-artifact.mjs <build|verify> [--source-root dir] [--output dir] [--source-commit sha]',
    )}
}
