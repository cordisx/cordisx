#!/usr/bin/env node
import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const generated = [
  'packages/channel-runtime/dist',
  'packages/schemastery-ui/dist',
  'packages/cli/dist',
]
const backup = await mkdtemp(path.join(tmpdir(), 'cordisx-clean-dev-'))
const moved = []

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

try {
  for (const relative of generated) {
    const source = path.join(root, relative)
    if (!(await exists(source))) continue
    const target = path.join(backup, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await rename(source, target)
    moved.push(relative)
  }

  await exec('npm', ['run', 'prepare:dev'], { cwd: root, maxBuffer: 16 * 1024 * 1024 })

  const bundleModule = await import(
    `${pathToFileURL(path.join(root, 'packages/cli/dist/src/launcher/bundle.js')).href}?clean-dev=${Date.now()}`
  )
  const configModule = await import(
    `${pathToFileURL(path.join(root, 'packages/cli/dist/src/launcher/config.js')).href}?clean-dev=${Date.now()}`
  )
  const config = await configModule.loadConfig(path.join(root, 'cordisx.config.example.json'))
  const bundle = await bundleModule.buildRendererBundle(config)
  if (typeof bundle !== 'string' || bundle.length === 0) throw new Error('clean development renderer bundle is empty')

  await rm(backup, { recursive: true, force: true })
  console.log('[clean-dev] source CLI preparation and renderer bundle verified')
} catch (error) {
  for (const relative of generated) {
    await rm(path.join(root, relative), { recursive: true, force: true })
  }
  for (const relative of moved) {
    const source = path.join(backup, relative)
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await rename(source, target)
  }
  await rm(backup, { recursive: true, force: true })
  throw error
}
