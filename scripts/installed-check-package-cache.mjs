import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { npmPackItem } from './npm-pack-report.mjs'

const execute = promisify(execFile)
const EXTERNAL_PACKAGES = ['@cordisx/channel', '@cordisx/plugin-cli-proxy-api', '@cordisx/protocol']

function packedFilename(stdout, packageName) {
  const report = JSON.parse(stdout)
  const filename = npmPackItem(report, packageName).filename
  if (typeof filename !== 'string' || filename.length === 0) throw new Error(`npm pack omitted ${packageName}`)
  return filename
}

export async function packWorkspace(repositoryRoot, workspace, packDirectory) {
  const { stdout } = await execute('npm', [
    'pack',
    `--workspace=${workspace}`,
    '--pack-destination',
    packDirectory,
    '--json',
  ], { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
  return path.join(packDirectory, packedFilename(stdout, workspace))
}

export async function packInstalledDependencyClosure(runnerDirectory, packDirectory, environment) {
  return Object.fromEntries(
    await Promise.all(EXTERNAL_PACKAGES.map(async packageName => {
      const packageRoot = path.join(runnerDirectory, 'node_modules', ...packageName.split('/'))
      const packSource = path.join(packDirectory, 'sources', packageName.replaceAll('/', '__'))
      await mkdir(path.dirname(packSource), { recursive: true })
      await cp(packageRoot, packSource, { recursive: true })
      const manifestPath = path.join(packSource, 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (manifest.scripts !== undefined) {
        delete manifest.scripts.prepare
        delete manifest.scripts.prepack
        delete manifest.scripts.postpack
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      }
      const { stdout } = await execute('npm', [
        'pack',
        packSource,
        '--pack-destination',
        packDirectory,
        '--json',
      ], { cwd: runnerDirectory, env: environment, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
      return [packageName, `file:${path.join(packDirectory, packedFilename(stdout, packageName))}`]
    })),
  )
}

export async function usePackedDependencyClosure(packagePath, dependencyClosure) {
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'))
  manifest.devDependencies = { ...manifest.devDependencies, ...dependencyClosure }
  manifest.overrides = {
    ...manifest.overrides,
    ...Object.fromEntries(Object.keys(dependencyClosure).map(packageName => [packageName, `$${packageName}`])),
  }
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}
