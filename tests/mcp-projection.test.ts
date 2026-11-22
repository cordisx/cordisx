import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'smol-toml'
import { createDefaultHomeConfig, parseHomeConfig, redactedHomeConfig } from '../packages/cli/src/config/home-config.js'
import { prepareClaudeMcp, projectMcpToCodex } from '../packages/cli/src/launcher/mcp-projection.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-mcp-test-'))
  dirs.push(dir)
  return dir
}
const mcp = {
  servers: {
    local: { type: 'stdio', command: 'node', args: ['server.js'], cwd: '/tmp', env: { TOKEN: { env: 'SECRET' } } },
    remote: {
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: { env: 'SECRET' }, Region: 'local' },
    },
  },
  apps: { 'claude-code': { local: null, remote: { type: 'http', url: 'https://example.org/mcp' } } },
}

describe('MCP configuration projection', () => {
  it('validates declarations, overrides and redacts values', () => {
    const config = parseHomeConfig({ ...createDefaultHomeConfig(), mcp })
    expect(JSON.stringify(redactedHomeConfig(config))).not.toContain('https://example.com')
    expect(() =>
      parseHomeConfig({ ...createDefaultHomeConfig(), mcp: { servers: { bad: { type: 'sse', url: 'x' } } } })
    ).toThrow(/supported transports/)
  })
  it('merges, updates and removes only intact managed Codex entries', async () => {
    const dir = await fixture(), file = path.join(dir, 'config.toml')
    const original = '# user config\nmodel = "native"\n\n[mcp_servers.personal]\ncommand = "personal"\n'
    await writeFile(file, original)
    const config = parseHomeConfig({ ...createDefaultHomeConfig(), mcp }).mcp
    await projectMcpToCodex(config, dir, { SECRET: 'private-value' })
    const raw = await readFile(file, 'utf8')
    expect(raw).not.toContain('private-value')
    expect(parse(raw)).toMatchObject({
      model: 'native',
      mcp_servers: {
        personal: { command: 'personal' },
        local: { env_vars: ['SECRET'] },
        remote: { env_http_headers: { Authorization: 'SECRET' } },
      },
    })
    await projectMcpToCodex({ servers: { remote: config!.servers.remote! } }, dir, { SECRET: 'new-value' })
    expect(parse(await readFile(file, 'utf8')).mcp_servers).not.toHaveProperty('local')
    await projectMcpToCodex(undefined, dir, {})
    expect(await readFile(file, 'utf8')).toBe(original)
  })
  it('fails closed on native collision, modified block and missing env', async () => {
    const dir = await fixture(), file = path.join(dir, 'config.toml')
    const config = parseHomeConfig({ ...createDefaultHomeConfig(), mcp }).mcp
    await writeFile(file, '[mcp_servers.local]\ncommand="user"\n')
    await expect(projectMcpToCodex(config, dir, { SECRET: 'x' })).rejects.toThrow(/conflicts/)
    await writeFile(file, '')
    await expect(projectMcpToCodex(config, dir, {})).rejects.toThrow(/SECRET/)
    await projectMcpToCodex(config, dir, { SECRET: 'x' })
    await writeFile(file, (await readFile(file, 'utf8')).replace('server.js', 'changed.js'))
    await expect(projectMcpToCodex(undefined, dir, {})).rejects.toThrow(/modified/)
  })
  it('creates a private Claude adapter with per-app overrides and removes it after use', async () => {
    const config = parseHomeConfig({ ...createDefaultHomeConfig(), mcp }).mcp
    const adapter = await prepareClaudeMcp(config, { SECRET: 'private-value' })
    expect(JSON.parse(await readFile(adapter.file!, 'utf8'))).toEqual({
      mcpServers: { cordisx_remote: { type: 'http', url: 'https://example.org/mcp', headers: {} } },
    })
    await adapter.close()
    await expect(readFile(adapter.file!, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('protects Claude user and project servers from prefixed name collisions', async () => {
    const dir = await fixture()
    const config = parseHomeConfig({ ...createDefaultHomeConfig(), mcp }).mcp
    await writeFile(
      path.join(dir, '.claude.json'),
      JSON.stringify({ mcpServers: { cordisx_remote: { type: 'stdio', command: 'user' } } }),
    )
    await expect(prepareClaudeMcp(config, { HOME: dir }, dir)).rejects.toThrow(/conflicts/)
    await writeFile(path.join(dir, '.claude.json'), '{}')
    await writeFile(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { cordisx_remote: { type: 'stdio', command: 'project' } } }),
    )
    await expect(prepareClaudeMcp(config, { HOME: dir }, dir)).rejects.toThrow(/conflicts/)
  })
  it('does not replace a Codex config while another projection holds its lock', async () => {
    const dir = await fixture()
    await writeFile(path.join(dir, '.cordisx-mcp.lock'), 'other')
    const config = parseHomeConfig({ ...createDefaultHomeConfig(), mcp }).mcp
    await expect(projectMcpToCodex(config, dir, { SECRET: 'x' })).rejects.toThrow(/lock/)
    await expect(readFile(path.join(dir, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(dir, '.cordisx-mcp.lock'), 'utf8')).toBe('other')
  })
})
