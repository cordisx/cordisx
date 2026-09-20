import { chmod, mkdir, mkdtemp as createTemporaryDirectory, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { onTestFinished } from 'vitest'
import { removeStagedPluginPackage } from '../../packages/cli/src/launcher/plugin-package.js'

export async function mkdtemp(prefix: string): Promise<string> {
  const root = await createTemporaryDirectory(prefix)
  onTestFinished(async () => {
    const home = path.join(root, 'home')
    const digests = await readdir(path.join(home, 'packages', 'sha256')).catch(() => [])
    for (const digest of digests) await removeStagedPluginPackage(home, `sha256:${digest}`)
    await rm(root, { recursive: true, force: true })
  })
  return root
}

export async function createLocalDevelopmentFixture(root: string): Promise<{
  readonly project: string
  readonly entry: string
  readonly configPath: string
  readonly executable: string
}> {
  const project = path.join(root, 'project')
  const entry = path.join(project, 'demo.ts')
  const configPath = path.join(project, 'cordisx.config.json')
  const executable = path.join(root, 'exits-before-injection')
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
  await writeFile(entry, "export default { name: 'demo', apply() {} }\n")
  await writeFile(configPath, JSON.stringify({ version: 1, plugins: [] }))
  await writeFile(executable, '#!/usr/bin/env node\nprocess.exit(0)\n')
  await chmod(executable, 0o755)
  return { project, entry, configPath, executable }
}

export async function createBuiltinSkillFixture(root: string): Promise<string> {
  const source = path.join(root, 'builtin-skill')
  await mkdir(path.join(source, 'agents'), { recursive: true })
  await writeFile(
    path.join(source, 'SKILL.md'),
    '---\nname: cordisx-plugin-development\ndescription: test Skill\n---\n',
  )
  await writeFile(path.join(source, 'agents', 'openai.yaml'), 'interface:\n  display_name: "CordisX"\n')
  return source
}

export async function createBuiltinSkillsFixture(root: string): Promise<string> {
  const sourceRoot = path.join(root, 'builtin-skills')
  const sources = {
    cordisx: 'https://github.com/cordisx/cordisx/tree/main/skills/cordisx',
    'cordisx-docs': 'https://github.com/cordisx/docs/tree/main/skills/cordisx-docs',
    'cordisx-qa': 'https://github.com/cordisx/cordisx/tree/main/skills/cordisx-qa',
    'cordisx-plugin-development': 'https://github.com/cordisx/cordisx/tree/main/skills/cordisx-plugin-development',
  }
  for (const [skillName, sourceUrl] of Object.entries(sources)) {
    const source = path.join(sourceRoot, skillName)
    await mkdir(path.join(source, 'agents'), { recursive: true })
    await writeFile(path.join(source, 'SKILL.md'), `---\nname: ${skillName}\ndescription: test Skill\n---\n`)
    await writeFile(path.join(source, 'agents', 'openai.yaml'), `interface:\n  display_name: "${skillName}"\n`)
    await writeFile(path.join(source, 'version.json'), JSON.stringify({ version: 'test', source: sourceUrl }))
  }
  return sourceRoot
}
