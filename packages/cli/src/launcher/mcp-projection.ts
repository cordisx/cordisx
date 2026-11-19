import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse, stringify } from 'smol-toml'
import { type HomeMcpConfig, type McpServer, mcpServersForApp, type McpValue } from '../config/home-config-mcp.js'

const marker = /^# cordisx-mcp begin ([a-f0-9]{64})\n([\s\S]*?)# cordisx-mcp end\n?/gmu
const wrapper =
  `const {spawn}=require('node:child_process');const [cwd,command,mapping,...args]=process.argv.slice(1);if(cwd)process.chdir(cwd);const env={...process.env};for(const [key,name] of Object.entries(JSON.parse(mapping)))env[key]=process.env[name];const child=spawn(command,args,{env,stdio:'inherit'});child.on('error',()=>process.exit(1));child.on('exit',(code,signal)=>{if(signal){process.removeAllListeners(signal);process.kill(process.pid,signal)}else process.exit(code??1)});for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>child.kill(signal));`
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex')

function resolve(value: McpValue, environment: NodeJS.ProcessEnv, server: string): string {
  if (typeof value === 'string') return value
  const result = environment[value.env]
  if (!result) throw new Error(`MCP server ${server}: required environment variable ${value.env} is missing or empty`)
  return result
}
function prepare(server: McpServer, name: string, environment: NodeJS.ProcessEnv, app: 'codex' | 'claude-code') {
  if (server.type === 'http') {
    const url = resolve(server.url, environment, name)
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error()
    } catch {
      throw new Error(`MCP server ${name}: invalid HTTP URL`)
    }
    const literal: Record<string, string> = Object.create(null), refs: Record<string, string> = Object.create(null)
    for (const [key, item] of Object.entries(server.headers ?? {})) {
      if (typeof item === 'string') literal[key] = item
      else {
        resolve(item, environment, name)
        refs[key] = item.env
      }
    }
    return app === 'codex'
      ? {
        url,
        ...(Object.keys(literal).length ? { http_headers: literal } : {}),
        ...(Object.keys(refs).length ? { env_http_headers: refs } : {}),
      }
      : {
        type: 'http',
        url,
        headers: {
          ...literal,
          ...Object.fromEntries(Object.entries(refs).map(([key, env]) => [key, environment[env]!])),
        },
      }
  }
  const literal: Record<string, string> = Object.create(null), refs: Record<string, string> = Object.create(null)
  for (const [key, item] of Object.entries(server.env ?? {})) {
    if (typeof item === 'string') literal[key] = item
    else {
      resolve(item, environment, name)
      refs[key] = item.env
    }
  }
  // Claude Code has no per-server cwd field. The wrapper also forwards renamed
  // environment references without storing their resolved values in config.
  const needsWrapper = !!server.cwd || Object.keys(refs).length > 0
  const command = needsWrapper ? process.execPath : server.command
  const args = needsWrapper
    ? ['-e', wrapper, server.cwd ?? '', server.command, JSON.stringify(refs), ...server.args ?? []]
    : server.args ?? []
  return {
    ...(app === 'claude-code' ? { type: 'stdio' } : {}),
    command,
    args,
    ...(Object.keys(literal).length ? { env: literal } : {}),
    ...(app === 'codex' && Object.keys(refs).length ? { env_vars: [...new Set(Object.values(refs))] } : {}),
  }
}

/** Reconcile only the intact, integrity-marked CordisX block; reject native name collisions. */
export async function projectMcpToCodex(
  config: HomeMcpConfig | undefined,
  home: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const desired = mcpServersForApp(config, 'codex')
  const target = path.join(home, 'config.toml')
  let raw = ''
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) {
      throw new Error('MCP projection requires a regular Codex config.toml')
    }
    raw = await readFile(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const blocks = [...raw.matchAll(marker)]
  if (
    blocks.length > 1 || raw.includes('# cordisx-mcp begin') && blocks.length !== 1
    || raw.includes('# cordisx-mcp end') && blocks.length !== 1
  ) {
    throw new Error('MCP projection found invalid CordisX ownership markers')
  }
  if (!blocks.length && !Object.keys(desired).length) return
  if (blocks[0] && hash(blocks[0][2]!) !== blocks[0][1]) {
    throw new Error('CordisX-managed MCP block was modified; preserve and resolve it manually')
  }
  const base = raw.replace(marker, '')
  let parsed: Record<string, unknown>
  try {
    parsed = parse(base)
  } catch {
    throw new Error('Cannot safely parse Codex config.toml for MCP projection')
  }
  const native = parsed.mcp_servers
  if (native !== undefined && (!native || typeof native !== 'object' || Array.isArray(native))) {
    throw new Error('Invalid native Codex MCP configuration')
  }
  for (const name of Object.keys(desired)) {
    if (native && Object.hasOwn(native, name)) {
      throw new Error(`MCP server ${name} conflicts with an existing native Codex server`)
    }
  }
  const entries = Object.fromEntries(
    Object.entries(desired).map(([name, item]) => [name, prepare(item, name, environment, 'codex')]),
  )
  const body = Object.keys(entries).length ? stringify({ mcp_servers: entries }) : ''
  const output = base
    + (body
      ? `${base && !base.endsWith('\n') ? '\n' : ''}# cordisx-mcp begin ${hash(body)}\n${body}# cordisx-mcp end\n`
      : '')
  try {
    parse(output)
  } catch {
    throw new Error('Cannot safely merge MCP servers into Codex config.toml')
  }
  if (raw === output) return
  await mkdir(home, { recursive: true, mode: 0o700 })
  const tmp = path.join(home, `.cordisx-mcp-${randomUUID()}.tmp`)
  const lockPath = path.join(home, '.cordisx-mcp.lock')
  let lock: Awaited<ReturnType<typeof open>>
  try {
    lock = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Another CordisX MCP projection holds the Codex config lock')
    }
    throw error
  }
  const owned = await lock.stat()
  try {
    await writeFile(tmp, output, { mode: 0o600, flag: 'wx' })
    const current = await readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    if (current !== raw) throw new Error('Codex config changed during MCP projection; retry launch')
    await rename(tmp, target)
  } finally {
    await rm(tmp, { force: true })
    await lock.close()
    const current = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (current?.dev === owned.dev && current.ino === owned.ino) await rm(lockPath)
  }
}

async function assertClaudeNamesAvailable(
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  const home = environment.HOME || os.homedir()
  const global = environment.CLAUDE_CONFIG_DIR
    ? path.join(path.resolve(cwd, environment.CLAUDE_CONFIG_DIR), '.claude.json')
    : path.join(home, '.claude.json')
  const files = [global]
  let directory = path.resolve(cwd)
  while (true) {
    files.push(path.join(directory, '.mcp.json'))
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const table = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  for (const file of files) {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error('Cannot inspect native Claude Code MCP configuration')
    }
    let document: Record<string, unknown>
    try {
      document = table(JSON.parse(raw))
    } catch {
      throw new Error('Cannot inspect native Claude Code MCP configuration')
    }
    const scopes = [
      table(document.mcpServers),
      ...Object.values(table(document.projects)).map(project => table(table(project).mcpServers)),
    ]
    for (const name of names) {
      if (scopes.some(scope => Object.hasOwn(scope, name))) {
        throw new Error(`CordisX MCP server ${name} conflicts with a native Claude Code server`)
      }
    }
  }
}

/** A private per-session adapter leaves all native Claude scopes untouched. */
export async function prepareClaudeMcp(
  config: HomeMcpConfig | undefined,
  environment: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): Promise<{ file?: string; close(): Promise<void> }> {
  const desired = mcpServersForApp(config, 'claude-code')
  const entries = Object.fromEntries(
    Object.entries(desired).map(([name, item]) => [`cordisx_${name}`, prepare(item, name, environment, 'claude-code')]),
  )
  if (!Object.keys(entries).length) return { async close() {} }
  await assertClaudeNamesAvailable(Object.keys(entries), environment, cwd)
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-claude-mcp-'))
  const file = path.join(dir, 'mcp.json')
  try {
    await writeFile(file, JSON.stringify({ mcpServers: entries }), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
  return {
    file,
    async close() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}
