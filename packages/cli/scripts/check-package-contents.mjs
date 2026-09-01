import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extract as extractTar } from 'tar'
import { npmPackItem } from '../../../scripts/npm-pack-report.mjs'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const packRoot = mkdtempSync(path.join(os.tmpdir(), 'cordisx-package-contents-'))
let packItem
let files
try {
  const output = execFileSync(
    'npm',
    ['pack', '--json', '--workspace=cordisx', '--ignore-scripts', '--pack-destination', packRoot],
    { cwd: repositoryRoot, encoding: 'utf8' },
  )
  const report = JSON.parse(output)
  packItem = npmPackItem(report, 'cordisx')
  files = packItem.files?.map(file => file.path)
  if (!Array.isArray(files)) throw new Error('npm pack did not report package contents')

const listFiles = directory => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory()
      ? listFiles(target).map(file => path.posix.join(entry.name, file))
      : [entry.name]
  })
  .sort()

const sourceSkillRoot = path.join(repositoryRoot, 'skills/cordisx-plugin-development')
const bundledSkillRoot = path.join(repositoryRoot, 'packages/cli/dist/skills/cordisx-plugin-development')
const extractedRoot = path.join(packRoot, 'extracted')
mkdirSync(extractedRoot)
if (typeof packItem.filename !== 'string') throw new Error('npm pack did not report a tarball filename')
await extractTar({ cwd: extractedRoot, file: path.join(packRoot, packItem.filename) })
const tarballSkillRoot = path.join(extractedRoot, 'package/dist/skills/cordisx-plugin-development')
const packagedSkillModule = await import(pathToFileURL(
  path.join(extractedRoot, 'package/dist/src/launcher/builtin-skill.js'),
).href)
const deploymentHome = path.join(packRoot, 'deployment-home')
const deployment = await packagedSkillModule.deployBundledCordisXSkill({
  version: 1,
  appId: 'codex',
  appName: 'Codex',
  profileId: 'package-check',
  dataMode: 'shared',
  executable: process.execPath,
  chromiumProfile: { mode: 'independent', path: path.join(packRoot, 'chromium') },
  environment: {},
  sharedDataRoots: [{ name: 'HOME', path: deploymentHome, managed: false }],
  isolatedDataRoots: [],
})
if (deployment.status !== 'installed' || deployment.effectiveHome !== deploymentHome) {
  throw new Error('tarball CordisX Skill deployment smoke returned an unexpected projection')
}
const sourceSkillFiles = listFiles(sourceSkillRoot)
const bundledSkillFiles = listFiles(bundledSkillRoot)
const tarballSkillFiles = listFiles(tarballSkillRoot)
if (
  JSON.stringify(sourceSkillFiles) !== JSON.stringify(bundledSkillFiles)
  || JSON.stringify(sourceSkillFiles) !== JSON.stringify(tarballSkillFiles)
) {
  throw new Error('cordisx package Skill is not a complete mirror of skills/cordisx-plugin-development')
}
for (const required of [
  'SKILL.md',
  'agents/openai.yaml',
  'references/plugin-authoring.md',
  'references/schema-configuration.md',
  'references/ui-system.md',
  'references/verification.md',
]) {
  if (!sourceSkillFiles.includes(required)) throw new Error(`CordisX Skill source is missing ${required}`)
}
for (const relative of sourceSkillFiles) {
  const source = readFileSync(path.join(sourceSkillRoot, relative))
  const bundled = readFileSync(path.join(bundledSkillRoot, relative))
  const tarball = readFileSync(path.join(tarballSkillRoot, relative))
  if (!source.equals(bundled)) throw new Error(`packaged CordisX Skill content differs: ${relative}`)
  if (!source.equals(tarball)) throw new Error(`CordisX Skill tarball content differs: ${relative}`)
  const tarballPath = path.posix.join('dist/skills/cordisx-plugin-development', relative)
  if (!files.includes(tarballPath)) throw new Error(`cordisx package is missing ${tarballPath}`)
}
const deployedSkillFiles = listFiles(deployment.targetDir)
  .filter(relative => relative !== packagedSkillModule.CORDISX_SKILL_MARKER_FILE)
if (JSON.stringify(sourceSkillFiles) !== JSON.stringify(deployedSkillFiles)) {
  throw new Error('tarball CordisX Skill deployment did not publish the complete Skill')
}

const allowedRoots = [
  'CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md',
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
]
const bundledSchemasteryUi = 'node_modules/@cordisx/schemastery-ui/'
const leaked = files.filter(file => (
  !allowedRoots.includes(file) && !file.startsWith('dist/') && !file.startsWith('third_party/') && !file.startsWith(bundledSchemasteryUi)
))
if (leaked.length > 0) throw new Error(`cordisx package leaked non-allowlisted files: ${leaked.join(', ')}`)

const harnessLeak = files.filter(file => /connector-(?:production|harness)/i.test(file))
if (harnessLeak.length > 0) throw new Error(`cordisx package leaked Connector smoke harness artifacts: ${harnessLeak.join(', ')}`)

const harnessPattern = /connector-(?:production|harness)|installConnectorProductionFixture/i
const bundledHarness = []
const distRoot = path.join(repositoryRoot, 'packages/cli/dist')
const scanDistribution = directory => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) scanDistribution(target)
    else if ((entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) && harnessPattern.test(readFileSync(target, 'utf8'))) {
      bundledHarness.push(path.relative(repositoryRoot, target))
    }
  }
}
if (existsSync(distRoot)) scanDistribution(distRoot)
if (bundledHarness.length > 0) throw new Error(`cordisx distribution contains a Connector smoke harness enable path: ${bundledHarness.join(', ')}`)

for (const required of [
  'CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md',
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'third_party/reicon-MIT.txt',
  'third_party/reicon-icon-credits.txt',
  'third_party/tdesign-web-components-subset-MIT.txt',
  'dist/src/cli.js',
  'dist/src/contracts.js',
  'dist/src/contracts.d.ts',
  'dist/skills/cordisx-plugin-development/SKILL.md',
  'dist/skills/cordisx-plugin-development/agents/openai.yaml',
  'dist/src/plugins/cli-proxy-api/README.md',
  'dist/src/plugins/cli-proxy-api/README.zh-Hans.md',
  'dist/src/plugins/channel/README.md',
  'dist/src/plugins/channel/README.zh-Hans.md',
  'dist/src/plugins/channel/service.mjs',
  'dist/assets/brand/cordisx-mark-light.svg',
  'dist/assets/brand/cordisx-mark-dark.svg',
  'dist/assets/brand/cordisx-mark-animated-light.svg',
  'dist/assets/brand/cordisx-mark-animated-dark.svg',
  'node_modules/@cordisx/schemastery-ui/package.json',
  'node_modules/@cordisx/schemastery-ui/LICENSE',
  'node_modules/@cordisx/schemastery-ui/CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md',
  'node_modules/@cordisx/schemastery-ui/dist/index.js',
  'node_modules/@cordisx/schemastery-ui/dist/index.d.ts',
]) {
  if (!files.includes(required)) throw new Error(`cordisx package is missing ${required}`)
}

console.log(`[cordisx] package allowlist verified: ${files.length} files`)
} finally {
  rmSync(packRoot, { recursive: true, force: true })
}
