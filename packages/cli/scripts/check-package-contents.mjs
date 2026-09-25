import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extract as extractTar } from 'tar'
import { npmPackItem } from '../../../scripts/npm-pack-report.mjs'
import {
  NATIVE_HELPER_MANIFEST,
  NATIVE_HELPERS,
  NATIVE_RESOURCES,
  verifyNativeHelperArtifact,
} from './native-helper-artifact.mjs'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const packRoot = mkdtempSync(path.join(os.tmpdir(), 'cordisx-package-contents-'))
try {
  const output = execFileSync(
    'npm',
    ['pack', '--json', '--workspace=cordisx', '--ignore-scripts', '--pack-destination', packRoot],
    { cwd: repositoryRoot, encoding: 'utf8' },
  )
  const report = JSON.parse(output)
  const packItem = npmPackItem(report, 'cordisx')
  const files = packItem.files?.map(file => file.path)
  if (!Array.isArray(files)) throw new Error('npm pack did not report package contents')
  const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, 'packages/cli/package.json'), 'utf8'))
  if (
    manifest.scripts?.postinstall !== 'node scripts/refresh-existing-app.mjs'
    || !files.includes('scripts/refresh-existing-app.mjs')
    || !files.includes('dist/src/app-launcher/postinstall.js')
  ) throw new Error('cordisx tarball must include its existing-App upgrade hook')

  const listFiles = directory =>
    readdirSync(directory, { withFileTypes: true })
      .flatMap(entry => {
        const target = path.join(directory, entry.name)
        return entry.isDirectory()
          ? listFiles(target).map(file => path.posix.join(entry.name, file))
          : [entry.name]
      })
      .sort()

  const bundledSkillNames = [
    'cordisx',
    'cordisx-docs',
    'cordisx-qa',
    'cordisx-plugin-development',
    'cordisx-feedback',
  ]
  const preservedRendererStyles = [
    'renderer/host-ui/public-markdown-editor.css',
    'renderer/model-providers.css',
    'renderer/manager/pages/model-services.css',
    'renderer/manager/pages/model-catalog/model-catalog.css',
  ]
  const extractedRoot = path.join(packRoot, 'extracted')
  mkdirSync(extractedRoot)
  if (typeof packItem.filename !== 'string') throw new Error('npm pack did not report a tarball filename')
  await extractTar({ cwd: extractedRoot, file: path.join(packRoot, packItem.filename) })
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  const packagedNativeRoot = path.join(extractedRoot, 'package/dist/native')
  verifyNativeHelperArtifact(path.join(repositoryRoot, 'packages/cli'), packagedNativeRoot, sourceCommit)
  for (const name of [...Object.keys(NATIVE_HELPERS), ...NATIVE_RESOURCES, NATIVE_HELPER_MANIFEST]) {
    const nativePath = path.posix.join('dist/native', name)
    if (!files.includes(nativePath)) throw new Error(`cordisx package is missing ${nativePath}`)
  }
  const packagedSkillModule = await import(
    pathToFileURL(
      path.join(extractedRoot, 'package/dist/src/launcher/builtin-skill.js'),
    ).href
  )
  const deploymentHome = path.join(packRoot, 'deployment-home')
  const deployment = await packagedSkillModule.deployBundledCordisXSkills({
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
  if (
    deployment.effectiveHome !== deploymentHome
    || deployment.conflicts.length !== 0
    || deployment.deployments.length !== bundledSkillNames.length
    || deployment.deployments.some(item => item.status !== 'installed')
  ) {
    throw new Error('tarball CordisX Skills deployment smoke returned an unexpected projection')
  }
  for (const relative of preservedRendererStyles) {
    const sourceStyle = readFileSync(path.join(repositoryRoot, 'packages/cli/src', relative))
    const bundledStyle = readFileSync(path.join(repositoryRoot, 'packages/cli/dist/src', relative))
    const tarballStyle = readFileSync(path.join(extractedRoot, 'package/dist/src', relative))
    if (!sourceStyle.equals(bundledStyle)) {
      throw new Error(`bundled renderer stylesheet differs from source: ${relative}`)
    }
    if (!sourceStyle.equals(tarballStyle)) {
      throw new Error(`renderer stylesheet differs in the cordisx tarball: ${relative}`)
    }
  }
  for (const skillName of bundledSkillNames) {
    const sourceSkillRoot = path.join(repositoryRoot, 'skills', skillName)
    const bundledSkillRoot = path.join(repositoryRoot, 'packages/cli/dist/skills', skillName)
    const tarballSkillRoot = path.join(extractedRoot, 'package/dist/skills', skillName)
    const deployedSkillRoot = path.join(deploymentHome, '.agents', 'skills', skillName)
    const sourceSkillFiles = listFiles(sourceSkillRoot)
    const bundledSkillFiles = listFiles(bundledSkillRoot)
    const tarballSkillFiles = listFiles(tarballSkillRoot)
    if (
      JSON.stringify(sourceSkillFiles) !== JSON.stringify(bundledSkillFiles)
      || JSON.stringify(sourceSkillFiles) !== JSON.stringify(tarballSkillFiles)
    ) {
      throw new Error(`cordisx package Skill is not a complete mirror of skills/${skillName}`)
    }
    for (const required of ['SKILL.md', 'version.json', 'agents/openai.yaml']) {
      if (!sourceSkillFiles.includes(required)) throw new Error(`${skillName} source is missing ${required}`)
    }
    if (skillName === 'cordisx-plugin-development') {
      for (
        const required of [
          'references/css-and-lifecycle.md',
          'references/feasibility-assessment.md',
          'references/live-plugin-development.md',
          'references/plugin-authoring.md',
          'references/project-layouts-and-development.md',
          'references/schema-configuration.md',
          'references/ui-system.md',
          'references/verification.md',
        ]
      ) {
        if (!sourceSkillFiles.includes(required)) throw new Error(`${skillName} source is missing ${required}`)
      }
    }
    if (skillName === 'cordisx-docs') {
      const upstream = JSON.parse(readFileSync(path.join(sourceSkillRoot, 'upstream.json'), 'utf8'))
      if (typeof upstream.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(upstream.commit)) {
        throw new Error('cordisx-docs upstream.json must record an exact Git commit')
      }
      for (const relative of ['SKILL.md', 'agents/openai.yaml', 'version.json']) {
        const expected = upstream.files?.[relative]
        const actual = `sha256:${
          createHash('sha256').update(readFileSync(path.join(sourceSkillRoot, relative))).digest('hex')
        }`
        if (expected !== actual) {
          throw new Error(`cordisx-docs upstream.json digest differs for ${relative}`)
        }
      }
    }
    const deployedMarker = JSON.parse(
      readFileSync(path.join(deployedSkillRoot, packagedSkillModule.CORDISX_SKILL_MARKER_FILE), 'utf8'),
    )
    const sourceVersion = JSON.parse(readFileSync(path.join(sourceSkillRoot, 'version.json'), 'utf8'))
    if (JSON.stringify(deployedMarker.provenance) !== JSON.stringify(sourceVersion)) {
      throw new Error(`packaged CLI did not deploy the ${skillName} provenance`)
    }
    for (const relative of sourceSkillFiles) {
      const source = readFileSync(path.join(sourceSkillRoot, relative))
      const bundled = readFileSync(path.join(bundledSkillRoot, relative))
      const tarball = readFileSync(path.join(tarballSkillRoot, relative))
      if (!source.equals(bundled)) throw new Error(`packaged ${skillName} content differs: ${relative}`)
      if (!source.equals(tarball)) throw new Error(`${skillName} tarball content differs: ${relative}`)
      const tarballPath = path.posix.join('dist/skills', skillName, relative)
      if (!files.includes(tarballPath)) throw new Error(`cordisx package is missing ${tarballPath}`)
    }
    const deployedSkillFiles = listFiles(deployedSkillRoot)
      .filter(relative => relative !== packagedSkillModule.CORDISX_SKILL_MARKER_FILE)
    if (JSON.stringify(sourceSkillFiles) !== JSON.stringify(deployedSkillFiles)) {
      throw new Error(`tarball CordisX Skill deployment did not publish the complete ${skillName} Skill`)
    }
    for (const relative of sourceSkillFiles) {
      const source = readFileSync(path.join(sourceSkillRoot, relative))
      const deployed = readFileSync(path.join(deployedSkillRoot, relative))
      if (!source.equals(deployed)) throw new Error(`deployed ${skillName} content differs: ${relative}`)
    }
  }

  const allowedRoots = [
    'CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md',
    'LICENSE',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    'package.json',
    'scripts/refresh-existing-app.mjs',
  ]
  const bundledRoots = ['@cordisx/schemastery-ui'].map(name => `node_modules/${name}/`)
  for (
    const required of [
      'dist/bundled-plugins/@cordisx/channel/dist/channel.js',
      'dist/bundled-plugins/@cordisx/channel/dist/channel.d.ts',
      'dist/bundled-plugins/@cordisx/channel/dist/service.mjs',
      'dist/bundled-plugins/@cordisx/plugin-cli-proxy-api/dist/runtime/module.js',
    ]
  ) {
    if (!files.includes(required)) throw new Error(`missing bundled runtime: ${required}`)
  }
  const leaked = files.filter(file => (
    !allowedRoots.includes(file) && !file.startsWith('dist/') && !file.startsWith('third_party/')
    && !bundledRoots.some(root => file.startsWith(root))
  ))
  if (leaked.length > 0) throw new Error(`cordisx package leaked non-allowlisted files: ${leaked.join(', ')}`)

  const harnessLeak = files.filter(file => /connector-(?:production|harness)/i.test(file))
  if (harnessLeak.length > 0) {
    throw new Error(`cordisx package leaked Connector smoke harness artifacts: ${harnessLeak.join(', ')}`)
  }

  const harnessPattern = /connector-(?:production|harness)|installConnectorProductionFixture/i
  const bundledHarness = []
  const distRoot = path.join(repositoryRoot, 'packages/cli/dist')
  const scanDistribution = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) scanDistribution(target)
      else if (
        (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts'))
        && harnessPattern.test(readFileSync(target, 'utf8'))
      ) {
        bundledHarness.push(path.relative(repositoryRoot, target))
      }
    }
  }
  if (existsSync(distRoot)) scanDistribution(distRoot)
  if (bundledHarness.length > 0) {
    throw new Error(`cordisx distribution contains a Connector smoke harness enable path: ${bundledHarness.join(', ')}`)
  }

  for (
    const required of [
      'CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md',
      'LICENSE',
      'README.md',
      'THIRD_PARTY_NOTICES.md',
      'third_party/reicon-MIT.txt',
      'third_party/reicon-icon-credits.txt',
      'dist/src/cli.js',
      'dist/src/contracts.js',
      'dist/src/contracts.d.ts',
      'dist/src/vite.js',
      'dist/src/vite.d.ts',
      'dist/src/launcher/builtin-skill.js',
      'dist/src/renderer/host-ui/public-markdown-editor.css',
      'dist/src/renderer/model-providers.css',
      'dist/src/renderer/manager/pages/model-services.css',
      'dist/src/renderer/manager/pages/model-catalog/model-catalog.css',
      'dist/skills/cordisx/SKILL.md',
      'dist/skills/cordisx/agents/openai.yaml',
      'dist/skills/cordisx-docs/SKILL.md',
      'dist/skills/cordisx-docs/agents/openai.yaml',
      'dist/skills/cordisx-docs/upstream.json',
      'dist/skills/cordisx-qa/SKILL.md',
      'dist/skills/cordisx-qa/agents/openai.yaml',
      'dist/skills/cordisx-plugin-development/SKILL.md',
      'dist/skills/cordisx-plugin-development/agents/openai.yaml',
      'dist/skills/cordisx-plugin-development/references/feasibility-assessment.md',
      'dist/skills/cordisx-plugin-development/references/live-plugin-development.md',
      'dist/skills/cordisx-plugin-development/references/project-layouts-and-development.md',
      'dist/skills/cordisx-feedback/SKILL.md',
      'dist/skills/cordisx-feedback/agents/openai.yaml',
      'dist/skills/cordisx-feedback/version.json',
      'dist/assets/feedback/feedback-manifest.schema.json',
      'dist/assets/brand/cordisx-mark-light.svg',
      'dist/assets/brand/cordisx-mark-dark.svg',
      'dist/assets/brand/cordisx-mark-animated-light.svg',
      'dist/assets/brand/cordisx-mark-animated-dark.svg',
      'dist/assets/launcher/native-provider-credential-helper.mjs',
      'dist/assets/launcher/native-app-server-intermediary.mjs',
      'node_modules/@cordisx/schemastery-ui/package.json',
      'node_modules/@cordisx/schemastery-ui/LICENSE',
      'node_modules/@cordisx/schemastery-ui/CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md',
      'node_modules/@cordisx/schemastery-ui/dist/index.js',
      'node_modules/@cordisx/schemastery-ui/dist/index.d.ts',
    ]
  ) {
    if (!files.includes(required)) throw new Error(`cordisx package is missing ${required}`)
  }

  console.log(`[cordisx] package allowlist verified: ${files.length} files`)
} finally {
  rmSync(packRoot, { recursive: true, force: true })
}
