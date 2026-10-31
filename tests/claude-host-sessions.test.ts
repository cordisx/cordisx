import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claudeProfileCli,
  resumes,
  claudeTranscript,
  createClaudeHostSessions,
  findClaudeTranscript,
  writeClaudeDesktopBinding,
} from '../packages/cli/src/launcher/claude-host-sessions.js'

const CLI_ID = '0b5c8a52-6c6a-4a1c-b982-51a43c159cba'

async function temporary(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'cx-claude-host-'))
}

/** A Claude Code CLI stand-in that records its arguments, stdin, and flag settings. */
async function fakeCli(dataDir: string, version: string, record: string): Promise<string> {
  const directory = path.join(dataDir, 'claude-code', version, 'build', 'claude.app', 'Contents', 'MacOS')
  await mkdir(directory, { recursive: true })
  const binary = path.join(directory, 'claude')
  await writeFile(binary, [
    '#!/bin/sh',
    `out=${JSON.stringify(record)}`,
    'printf "%s\\n" "$@" > "$out.args"',
    'cat > "$out.stdin"',
    'printf "%s\\n%s\\n" "$ANTHROPIC_BASE_URL" "$ANTHROPIC_AUTH_TOKEN" > "$out.gateway"',
    'pwd > "$out.cwd"',
  ].join('\n'))
  await chmod(binary, 0o755)
  return binary
}

async function until(file: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(file, 'utf8')
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  throw new Error(`${file} was never written`)
}

describe('Claude transcripts', () => {
  it('keeps user and assistant text and drops tool and bookkeeping lines', () => {
    const lines = [
      { type: 'queue-operation' },
      { type: 'user', message: { content: 'Tidy the README' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'file' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
    ].map(line => JSON.stringify(line)).join('\n')
    expect(claudeTranscript(`${lines}\nnot json`)).toEqual([
      { role: 'user', text: 'Tidy the README' },
      { role: 'assistant', text: 'Done.' },
    ])
  })

  it('finds a transcript by session id in any project folder', async () => {
    const home = await temporary()
    const project = path.join(home, '.claude', 'projects', '-work')
    await mkdir(project, { recursive: true })
    await writeFile(path.join(project, `${CLI_ID}.jsonl`), '')
    expect(await findClaudeTranscript(home, CLI_ID)).toBe(path.join(project, `${CLI_ID}.jsonl`))
    expect(await findClaudeTranscript(home, '../etc/passwd')).toBeUndefined()
  })

  it('picks the newest CLI Claude installed in the profile', async () => {
    const dataDir = await temporary()
    await fakeCli(dataDir, '2.1.9', path.join(dataDir, 'old'))
    const newest = await fakeCli(dataDir, '2.1.10', path.join(dataDir, 'new'))
    expect(await claudeProfileCli(dataDir, await temporary())).toBe(newest)
  })
})

describe('open Claude sessions', () => {
  it('counts only a Claude Code process resuming the session', () => {
    expect(resumes(`/x/claude --model=a --resume=${CLI_ID} --allowedTools=b`, CLI_ID)).toBe(true)
    expect(resumes(`/x/claude -p --resume ${CLI_ID} --model a`, CLI_ID)).toBe(true)
    expect(resumes(`node call.mjs claude send_message {"sessionId":"local_${CLI_ID}"}`, CLI_ID)).toBe(false)
    expect(resumes(`/x/claude --resume=${CLI_ID}0`, CLI_ID)).toBe(false)
  })
})

describe('Claude sessions driven from the host', () => {
  async function launched() {
    const cordisxHomeDir = await temporary()
    const homedir = await temporary()
    const dataDir = path.join(cordisxHomeDir, 'data-3p')
    const record = path.join(cordisxHomeDir, 'turn')
    await fakeCli(dataDir, '2.1.309', record)
    await writeClaudeDesktopBinding(cordisxHomeDir, {
      version: 1,
      profileId: 'e2e',
      homeDir: cordisxHomeDir,
      dataDir,
      provider: { id: 'sub2tok', baseUrl: 'https://api.sub2tok.com', apiKeyEnv: 'SUB2TOK_KEY', model: 'claude-opus-5-5' },
    })
    return { cordisxHomeDir, homedir, dataDir, record }
  }

  it('starts a session with the profile CLI in bypass mode on the bound model service', async () => {
    const { cordisxHomeDir, homedir, record } = await launched()
    const sessions = createClaudeHostSessions({
      cordisxHomeDir,
      homedir,
      secret: async name => name === 'SUB2TOK_KEY' ? 'sk-test' : undefined,
    })

    const started = await sessions('start_session', { prompt: 'Tidy the README', cwd: homedir }) as Record<string, string>

    expect(started).toEqual(expect.objectContaining({ status: 'started' }))
    expect(started.sessionId).toBe(`local_${started.cliSessionId}`)
    expect(started.link).toBe(`claude://resume?session=${started.cliSessionId}`)
    // The stand-in writes its working directory last.
    expect((await until(`${record}.cwd`)).trim()).toBe(await realpathOf(homedir))
    expect(await until(`${record}.stdin`)).toBe('Tidy the README')
    const args = (await until(`${record}.args`)).trim().split('\n')
    expect(args).toEqual(expect.arrayContaining([
      '-p',
      '--session-id',
      started.cliSessionId,
      '--permission-mode',
      'bypassPermissions',
      '--model',
      'claude-opus-5-5',
    ]))
    expect((await until(`${record}.gateway`)).trim().split('\n')).toEqual(['https://api.sub2tok.com', 'sk-test'])
  })

  it('refuses to start without the model service key', async () => {
    const { cordisxHomeDir, homedir } = await launched()
    const sessions = createClaudeHostSessions({ cordisxHomeDir, homedir, secret: async () => undefined })
    await expect(sessions('start_session', { prompt: 'x' })).rejects.toThrow(/SUB2TOK_KEY/)
    expect(await sessions('start_session', { prompt: 'x', cwd: 'relative' })).toEqual({
      status: 'rejected',
      reason: 'cwd-must-be-absolute',
    })
  })

  it('resumes a closed session for a message and hands an open one to its plugin', async () => {
    const { cordisxHomeDir, homedir, dataDir, record } = await launched()
    const folder = path.join(dataDir, 'claude-code-sessions', 'account', 'org')
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, `local_${CLI_ID}.json`), JSON.stringify({
      sessionId: `local_${CLI_ID}`,
      cliSessionId: CLI_ID,
      cwd: homedir,
      model: 'claude-sonnet-5-5',
    }))
    let open = ''
    const forwarded: unknown[] = []
    const sessions = createClaudeHostSessions({
      cordisxHomeDir,
      homedir,
      secret: async () => 'sk-test',
      processList: async () => open,
      viaPlugin: async (operation, args, target) => {
        forwarded.push([operation, args, target])
        return { status: 'sent' }
      },
    })

    expect(await sessions('send_message', { sessionId: CLI_ID, prompt: 'And the CHANGELOG' })).toEqual({
      status: 'sent',
      sessionId: `local_${CLI_ID}`,
      link: `claude://resume?session=${CLI_ID}`,
    })
    await until(`${record}.cwd`)
    expect((await until(`${record}.args`)).trim().split('\n')).toEqual(expect.arrayContaining([
      '--resume',
      CLI_ID,
      '--model',
      'claude-sonnet-5-5',
    ]))

    open = `/claude --resume ${CLI_ID}`
    expect(await sessions('send_message', { sessionId: `local_${CLI_ID}`, prompt: 'hi' })).toEqual({ status: 'sent' })
    expect(forwarded).toEqual([[
      'send_message',
      { sessionId: `local_${CLI_ID}`, cliSessionId: CLI_ID, prompt: 'hi' },
      CLI_ID,
    ]])
  })
})

async function realpathOf(directory: string): Promise<string> {
  const { realpath } = await import('node:fs/promises')
  return await realpath(directory)
}
