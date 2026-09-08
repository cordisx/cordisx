import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { verifyGeneratedViteGraph } from './check-installed-vite-graph.mjs'
import { usePackedDependencyClosure } from './installed-check-package-cache.mjs'

async function usePackedCordisX(packagePath, options) {
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'))
  if (manifest.devDependencies?.cordisx !== options.expectedVersion) {
    throw new Error(`generated CordisX dependency must be ${options.expectedVersion}`)
  }
  manifest.devDependencies.cordisx = `file:${options.cordisxTarball}`
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function assertViteProjectDryRun(stdout, pluginIds) {
  if (
    !stdout.includes('[cordisx] Vite entry ready:')
    || !stdout.includes('"status": "ready"')
    || !stdout.includes('"transport": "vite"')
    || pluginIds.some(id => !stdout.includes(`"${id}"`))
  ) throw new Error('generated plugin project was not accepted by cordisx dev --dry-run')
}

async function install(project, options) {
  await options.run('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: project,
    env: options.installEnvironment,
  })
}

export async function verifyGeneratedProject(project, options) {
  const packagePath = path.join(project, 'package.json')
  const [manifestSource, englishReadme, simplifiedChineseReadme] = await Promise.all([
    readFile(packagePath, 'utf8'),
    readFile(path.join(project, 'README.md'), 'utf8'),
    readFile(path.join(project, 'README.zh-Hans.md'), 'utf8'),
  ])
  const manifest = JSON.parse(manifestSource)
  if (!englishReadme.includes('CordisX plugin') || !simplifiedChineseReadme.includes('CordisX')) {
    throw new Error('generated plugin must include English and Simplified Chinese README fallbacks')
  }
  if (manifest.license !== 'UNLICENSED') throw new Error('generated plugin must leave an explicit license choice')
  await usePackedCordisX(packagePath, options)
  await usePackedDependencyClosure(packagePath, options.dependencyClosure)
  await install(project, options)
  await options.run('npm', ['run', 'check'], { cwd: project, env: options.installEnvironment })
  await verifyGeneratedViteGraph(path.join(project, 'dist', 'runtime'), 'generated standalone plugin')
  const dryRun = await options.run('npm', ['run', 'dev:dry-run'], { cwd: project, env: options.installEnvironment })
  assertViteProjectDryRun(dryRun.stdout, [])
}

export async function verifyGeneratedWorkspace(project, pluginIds, options) {
  const packagePath = path.join(project, 'package.json')
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'))
  if (manifest.license !== 'UNLICENSED' || !Array.isArray(manifest.workspaces)) {
    throw new Error('generated plugin workspace metadata is invalid')
  }
  await usePackedCordisX(packagePath, options)
  await usePackedDependencyClosure(packagePath, options.dependencyClosure)
  for (const id of pluginIds) {
    await usePackedCordisX(path.join(project, 'plugins', id, 'package.json'), options)
  }
  await install(project, options)
  await options.run('npm', ['run', 'check'], { cwd: project, env: options.installEnvironment })
  for (const id of pluginIds) {
    await verifyGeneratedViteGraph(
      path.join(project, 'plugins', id, 'dist', 'runtime'),
      `generated workspace plugin ${id}`,
    )
  }
  const dryRun = await options.run('npm', ['run', 'dev:dry-run'], { cwd: project, env: options.installEnvironment })
  assertViteProjectDryRun(dryRun.stdout, pluginIds)
}

export async function verifyGeneratedEmbedded(project, pluginIds, integrated, options) {
  const cordisxRoot = path.join(project, '.cordisx')
  const manifestPath = path.join(cordisxRoot, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.license !== 'UNLICENSED') throw new Error('embedded CordisX package license choice is not explicit')
  const rootManifestPath = path.join(project, 'package.json')
  const rootManifest = JSON.parse(await readFile(rootManifestPath, 'utf8'))
  if (integrated && !rootManifest.workspaces?.includes('.cordisx')) {
    throw new Error('embedded CordisX package did not join the npm workspace')
  }
  if (!integrated && rootManifest.workspaces !== undefined) {
    throw new Error('isolated embedded fixture unexpectedly became a workspace')
  }
  await usePackedCordisX(manifestPath, options)
  await usePackedDependencyClosure(integrated ? rootManifestPath : manifestPath, options.dependencyClosure)
  await install(integrated ? project : cordisxRoot, options)
  await options.run('npm', ['run', 'check'], { cwd: cordisxRoot, env: options.installEnvironment })
  for (const id of pluginIds) {
    await verifyGeneratedViteGraph(path.join(cordisxRoot, 'dist', 'runtime', id), `generated embedded plugin ${id}`)
  }
  const dryRun = await options.run('npm', ['run', 'dev:dry-run'], {
    cwd: cordisxRoot,
    env: options.installEnvironment,
  })
  assertViteProjectDryRun(dryRun.stdout, pluginIds)
}
