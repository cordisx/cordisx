#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HELP = `Usage:
  npm create cordisx-plugin <directory>
  npx create-cordisx-plugin <directory>

Creates a minimal trusted-local CordisX plugin project.`

interface CreatorManifest {
  readonly version: string
}

function packageName(directory: string): string {
  const normalized = path.basename(path.resolve(directory))
    .normalize('NFKD')
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 214)
  return normalized === '' ? 'cordisx-plugin' : normalized
}

function pluginId(name: string): string {
  return name === 'host' || name.startsWith('cordisx.') ? `local-${name}` : name
}

function replaceTokens(value: string, replacements: Readonly<Record<string, string>>): string {
  let output = value
  for (const [token, replacement] of Object.entries(replacements)) {
    output = output.replaceAll(`{{${token}}}`, replacement)
  }
  return output
}

async function targetState(target: string): Promise<'missing' | 'empty'> {
  try {
    const targetStat = await stat(target)
    if (!targetStat.isDirectory()) throw new Error(`target exists and is not a directory: ${target}`)
    const entries = await readdir(target)
    if (entries.length > 0) throw new Error(`target directory is not empty: ${target}`)
    return 'empty'
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'missing'
    throw error
  }
}

async function renderTemplate(
  source: string,
  destination: string,
  replacements: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const outputName = replaceTokens(
      entry.name === '_gitignore' ? '.gitignore' : entry.name,
      replacements,
    )
    const input = path.join(source, entry.name)
    const output = path.join(destination, outputName)
    if (entry.isDirectory()) {
      await renderTemplate(input, output, replacements)
      continue
    }
    if (!entry.isFile()) throw new Error(`unsupported template entry: ${input}`)
    const contents = replaceTokens(await readFile(input, 'utf8'), replacements)
    await writeFile(output, contents, { encoding: 'utf8', flag: 'wx' })
  }
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP)
    return
  }
  if (argv.length !== 1 || argv[0]?.startsWith('-')) throw new Error(HELP)

  const directory = argv[0]
  if (directory === undefined) throw new Error(HELP)
  const target = path.resolve(process.cwd(), directory)
  const state = await targetState(target)
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  const templateRoot = path.join(packageRoot, 'template')
  const creatorManifest = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as CreatorManifest
  if (typeof creatorManifest.version !== 'string' || creatorManifest.version.length === 0) {
    throw new Error('create-cordisx-plugin package version is invalid')
  }

  let created = false
  try {
    if (state === 'missing') {
      await mkdir(target, { recursive: false })
      created = true
    }
    const name = packageName(directory)
    await renderTemplate(templateRoot, target, {
      packageName: name,
      pluginId: pluginId(name),
      cordisxVersion: creatorManifest.version,
    })
  } catch (error) {
    if (created) await rm(target, { recursive: true, force: true })
    throw error
  }

  console.log(`Created CordisX plugin in ${target}`)
  console.log(`\nNext steps:\n  cd ${directory}\n  npm install\n  npm run check\n  npm run dev:dry-run`)
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`[create-cordisx-plugin] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
