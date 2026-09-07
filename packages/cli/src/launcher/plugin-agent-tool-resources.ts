import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { collectSkillFiles, digestSkillFiles } from './builtin-skill.js'

export interface AgentToolResources {
  readonly root: string
  readonly contract: 'cordisx.agent-tools/v1'
  readonly skills: readonly { readonly id: string; readonly path: string }[]
  readonly commands: readonly { readonly id: string; readonly entry: string; readonly skillId: string }[]
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid agent tool resources')
  }
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('unexpected agent tool resource field')
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new Error('invalid agent tool id')
  return value
}
async function resource(root: string, value: unknown, directory: boolean): Promise<string> {
  if (typeof value !== 'string' || !value.startsWith('./') || value.includes('\\')) {
    throw new Error('invalid resource path')
  }
  const parts = value.slice(2).split('/')
  if (parts.some(part => !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(part))) throw new Error('invalid resource path segment')
  let current = root
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    const metadata = await lstat(current)
    const expectsDirectory = index < parts.length - 1 || directory
    if (expectsDirectory ? !metadata.isDirectory() : !metadata.isFile()) {
      throw new Error('resource is not a real file/directory')
    }
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && metadata.nlink !== 1)) {
      throw new Error('resource links are forbidden')
    }
  }
  return current
}

/** The whole package snapshot already covers this adjacent descriptor and its resources. */
export async function readAgentToolResources(entry: string): Promise<AgentToolResources | undefined> {
  let root = path.dirname(entry)
  let ancestor = root
  while (true) {
    const packagePath = path.join(ancestor, 'cordisx-package.json')
    const packageFile = await lstat(packagePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (packageFile !== undefined) {
      if (!packageFile.isFile()) throw new Error('agent tool package manifest must be a real file')
      const manifest = record(JSON.parse(await readFile(packagePath, 'utf8')))
      if (typeof manifest.entry === 'string' && path.resolve(ancestor, manifest.entry) === path.resolve(entry)) {
        root = ancestor
        break
      }
    }
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  const descriptor = path.join(root, 'cordisx-agent-tools.json')
  const metadata = await lstat(descriptor).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (metadata === undefined) return undefined
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 16_384) {
    throw new Error('invalid agent tool descriptor file')
  }
  const raw = record(JSON.parse(await readFile(descriptor, 'utf8')))
  keys(raw, ['contract', 'skills', 'commands'])
  if (
    raw.contract !== 'cordisx.agent-tools/v1' || !Array.isArray(raw.skills) || !Array.isArray(raw.commands)
    || raw.skills.length !== 1 || raw.commands.length !== 1
  ) throw new Error('Host supports one declared Skill and command per plugin')
  const skills = await Promise.all(raw.skills.map(async value => {
    const item = record(value)
    keys(item, ['id', 'path'])
    const skillPath = await resource(root, item.path, true)
    await resource(skillPath, './SKILL.md', false)
    const files = await collectSkillFiles(skillPath, false)
    if (files.length > 256 || files.reduce((n, file) => n + file.content.length, 0) > 1_048_576) {
      throw new Error('Skill resource limit exceeded')
    }
    return { id: id(item.id), path: String(item.path) }
  }))
  const commands = await Promise.all(raw.commands.map(async value => {
    const item = record(value)
    keys(item, ['id', 'entry', 'skillId'])
    await resource(root, item.entry, false)
    if (!/\.[cm]?js$/.test(String(item.entry))) throw new Error('agent tool entry must be JavaScript')
    if (!skills.some(skill => skill.id === item.skillId)) throw new Error('unknown command Skill')
    return { id: id(item.id), entry: String(item.entry), skillId: id(item.skillId) }
  }))
  return { root, contract: 'cordisx.agent-tools/v1', skills, commands }
}

export async function deployAgentToolResources(entry: string, commandId: string, destination: string): Promise<{
  readonly skill: { readonly id: string; readonly path: string; readonly content: string }
  readonly commandPath: string
  readonly digest: string
}> {
  const resources = await readAgentToolResources(entry)
  const command = resources?.commands.find(item => item.id === commandId)
  const skill = resources?.skills.find(item => item.id === command?.skillId)
  if (command === undefined || skill === undefined) throw new Error('agent tool was not declared')
  const root = resources!.root
  const source = await resource(root, skill.path, true)
  const files = await collectSkillFiles(source, false)
  const skillRoot = path.join(destination, 'skill')
  await mkdir(skillRoot, { recursive: true, mode: 0o700 })
  for (const file of files) {
    const target = path.join(skillRoot, file.relativePath)
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, file.content, { flag: 'wx', mode: 0o600 })
  }
  const commandPath = path.join(destination, 'command.mjs')
  // Bundle the actual plugin CLI with the installed Host client. A private temp
  // deployment must not depend on ancestor node_modules or a developer PATH.
  const clientJs = fileURLToPath(new URL('../agent-tools.js', import.meta.url))
  const client = await lstat(clientJs).then(() => clientJs).catch(() => clientJs.replace(/\.js$/, '.ts'))
  await build({
    entryPoints: [await resource(root, command.entry, false)],
    outfile: commandPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { 'cordisx/agent-tools': client },
    logLevel: 'silent',
  })
  const skillPath = path.join(skillRoot, 'SKILL.md')
  return {
    skill: { id: skill.id, path: skillPath, content: await readFile(skillPath, 'utf8') },
    commandPath,
    digest: digestSkillFiles(files),
  }
}
