import os from 'node:os'
import path from 'node:path'
import { loadHomeConfig, resolveHomeConfigPath } from '../config/home-config.js'
import { installConfiguredSkills } from '../launcher/configured-skills.js'
import type { CordisXCliRuntime } from './run-runtime.js'

const HELP = `Usage: cordisx skills install|update [Git-URL[#ref][@skill]] [--client codex|claude-code|both]

Without a source, installs all sources in config.skills. install uses the cache;
update refreshes it. Explicit sources are installed once and do not change config.`

export async function runSkillsCommand(args: readonly string[], runtime: CordisXCliRuntime): Promise<void> {
  const stdout = runtime.stdout ?? console.log
  if (!args.length || args[0] === '--help' || args[0] === 'help') return stdout(HELP)
  if (!['install', 'update'].includes(args[0]!)) throw new Error(HELP)
  if (args.includes('--help')) return stdout(HELP)
  let client = 'both'
  let source: string | undefined
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--client') {
      client = args[++i] ?? ''
      if (!['codex', 'claude-code', 'both'].includes(client)) {
        throw new Error('--client must be codex, claude-code, or both')
      }
    } else if (!source && !args[i]!.startsWith('-')) source = args[i]
    else throw new Error(HELP)
  }
  const env = runtime.env ?? process.env
  const configPath = resolveHomeConfigPath({
    env,
    ...(runtime.homedir === undefined ? {} : { homedir: runtime.homedir }),
  })
  const config = source ? undefined : await loadHomeConfig(configPath)
  const sources = source ? [source] : config?.skills ?? []
  if (!sources.length) return stdout('[cordisx] No Skills configured')
  const home = runtime.homedir ?? env.HOME ?? os.homedir()
  const targets = [
    ...(client !== 'claude-code' ? [path.join(home, '.agents', 'skills')] : []),
    ...(client !== 'codex' ? [path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills')] : []),
  ]
  let failures = 0
  for (const [index, skillsDir] of targets.entries()) {
    failures += await installConfiguredSkills({
      sources,
      skillsDir,
      cacheDir: path.join(path.dirname(configPath), 'cache', 'skills'),
      update: args[0] === 'update' && index === 0,
      report: stdout,
      env,
    })
  }
  if (failures) throw new Error(`${failures} Skill source(s) failed; see diagnostics above`)
}
