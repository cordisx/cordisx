import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claudeLaunchPreferencePath,
  claudeProfileCli,
  claudeTranscript,
  createClaudeHostSessions,
  findClaudeTranscript,
  readClaudeSessionRecords,
  resumes,
  writeClaudeDesktopBinding,
} from '../packages/cli/src/launcher/claude-host-sessions.js'

const CLI_ID = '0b5c8a52-6c6a-4a1c-b982-51a43c159cba'

async function temporary(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'cx-claude-host-'))
}

/** A Claude Code CLI stand-in that records its arguments, stdin, and flag settings. */
async function fakeCli(dataDir: string, version: string, record: string, exitCode = 0): Promise<string> {
  const directory = path.join(dataDir, 'claude-code', version, 'build', 'claude.app', 'Contents', 'MacOS')
  await mkdir(directory, { recursive: true })
  const binary = path.join(directory, 'claude')
  await writeFile(
    binary,
    [
      '#!/bin/sh',
      `out=${JSON.stringify(record)}`,
      'printf "%s\\n" "$@" > "$out.args"',
      'cat > "$out.stdin"',
      'printf "%s\\n%s\\n" "$ANTHROPIC_BASE_URL" "$ANTHROPIC_AUTH_TOKEN" > "$out.gateway"',
      'pwd > "$out.cwd"',
      // The real CLI prints one JSON result on --output-format json; a failed one says is_error.
      exitCode === 0
        ? 'printf \'{"type":"result","is_error":false}\''
        : `printf '{"type":"result","is_error":true,"result":"model rejected the request"}'`,
      `exit ${exitCode}`,
    ].join('\n'),
  )
  await chmod(binary, 0o755)
  return binary
}

/** A CordisX home config declaring one Claude model service. */
async function writeModelServices(cordisxHomeDir: string): Promise<void> {
  const { createDefaultHomeConfig } = await import('../packages/cli/src/config/home-config.js')
  await writeFile(
    path.join(cordisxHomeDir, 'config.json'),
    JSON.stringify({
      ...createDefaultHomeConfig(),
      providers: [{
        id: 'other',
        kind: 'model-service',
        displayName: 'Other gateway',
        baseUrl: 'https://other.invalid',
        apiKeyEnv: 'OTHER_KEY',
        protocols: ['anthropic-messages'],
        models: { claude: ['claude-sonnet-5-5', 'claude-opus-5-5'] },
      }],
    }),
  )
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
      provider: {
        id: 'sub2tok',
        baseUrl: 'https://api.sub2tok.com',
        apiKeyEnv: 'SUB2TOK_KEY',
        model: 'claude-opus-5-5',
      },
    })
    return { cordisxHomeDir, homedir, dataDir, record }
  }

  it('starts a session with the profile CLI in bypass mode on the bound model service', async () => {
    const { cordisxHomeDir, homedir, record } = await launched()
    const sessions = createClaudeHostSessions({
      cordisxHomeDir,
      homedir,
      runningPid: async () => -1,
      secret: async name => name === 'SUB2TOK_KEY' ? 'sk-test' : undefined,
    })

    const started = await sessions('start_session', { prompt: 'Tidy the README', cwd: homedir }) as Record<
      string,
      string
    >

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
    const sessions = createClaudeHostSessions({
      cordisxHomeDir,
      homedir,
      runningPid: async () => -1,
      secret: async () => undefined,
    })
    // A missing key is the same structured failure as any other, not a thrown error.
    expect(await sessions('start_session', { prompt: 'x' })).toEqual(expect.objectContaining({
      status: 'failed',
      reason: 'provider-key-missing',
      retryable: false,
      detail: 'SUB2TOK_KEY',
    }))
    expect(await sessions('start_session', { prompt: 'x', cwd: 'relative' })).toEqual(expect.objectContaining({
      status: 'rejected',
      reason: 'cwd-must-be-absolute',
      retryable: false,
    }))
  })

  it('writes the requested title into the record list_sessions reads', async () => {
    const { cordisxHomeDir, homedir, dataDir } = await launched()
    const sessions = createClaudeHostSessions({
      cordisxHomeDir,
      homedir,
      runningPid: async () => -1,
      secret: async () => 'sk-test',
    })
    const started = await sessions('start_session', { prompt: 'x', title: 'Tidy the README' }) as Record<string, string>
    expect(started).toEqual(expect.objectContaining({ status: 'started', title: 'Tidy the README' }))
    const records = await readClaudeSessionRecords(dataDir)
    expect(records).toEqual([
      expect.objectContaining({ sessionId: `local_${started.cliSessionId}`, title: 'Tidy the README' }),
    ])
    expect(await sessions('list_sessions', {})).toEqual(expect.objectContaining({
      sessions: [expect.objectContaining({ title: 'Tidy the README' })],
    }))
  })

  it('runs the turn on a named model service and refuses one it does not declare', async () => {
    const { cordisxHomeDir, homedir, record } = await launched()
    await writeModelServices(cordisxHomeDir)
    const sessions = createClaudeHostSessions({
      cordisxHomeDir,
      homedir,
      runningPid: async () => -1,
      secret: async name => name === 'OTHER_KEY' ? 'sk-other' : name === 'SUB2TOK_KEY' ? 'sk-test' : undefined,
    })

    const started = await sessions('start_session', {
      prompt: 'x',
      providerId: 'other',
      model: 'claude-sonnet-5-5',
    }) as Record<string, string>
    expect(started).toEqual(expect.objectContaining({
      status: 'started',
      modelProvider: 'other',
      model: 'claude-sonnet-5-5',
    }))
    expect((await until(`${record}.gateway`)).trim().split('\n')).toEqual(['https://other.invalid', 'sk-other'])
    expect((await until(`${record}.args`)).trim().split('\n')).toContain('claude-sonnet-5-5')

    expect(await sessions('start_session', { prompt: 'x', providerId: 'nope' })).toEqual(expect.objectContaining({
      status: 'rejected',
      reason: 'provider-not-configured',
    }))
    expect(await sessions('start_session', { prompt: 'x', providerId: 'other', model: 'gpt-6.1' })).toEqual(
      expect.objectContaining({ status: 'rejected', reason: 'model-not-in-provider-catalog' }),
    )
    // A service only the profile's own library holds has no declaration to run from.
    await mkdir(path.join(cordisxHomeDir, 'data-3p', 'configLibrary'), { recursive: true })
    await writeFile(
      path.join(cordisxHomeDir, 'data-3p', 'configLibrary', '_meta.json'),
      JSON.stringify({ entries: [{ id: 'library-only', name: 'Library only' }] }),
    )
    expect(await sessions('start_session', { prompt: 'x', providerId: 'library-only' })).toEqual(
      expect.objectContaining({ status: 'rejected', reason: 'provider-not-declared' }),
    )
  })

  it('reports a first turn that failed', async () => {
    const { cordisxHomeDir, homedir, record } = await launched()
    await fakeCli(path.join(cordisxHomeDir, 'data-3p'), '2.1.310', record, 1)
    const sessions = createClaudeHostSessions({
      cordisxHomeDir,
      homedir,
      runningPid: async () => -1,
      secret: async () => 'sk-test',
    })
    const started = await sessions('start_session', { prompt: 'x' }) as Record<string, unknown>
    // A turn known to have failed is reported as failed, with the session still open.
    expect(started).toMatchObject({
      status: 'failed',
      reason: 'turn-failed',
      retryable: true,
      turn: { status: 'failed', error: expect.stringMatching(/model rejected the request/u) },
    })
    expect(typeof started.sessionId).toBe('string')
    // The gateway key never reaches the result.
    expect(JSON.stringify(started)).not.toMatch(/sk-test/)
  })

  it('answers while a long turn is still running instead of blocking on it', async () => {
    const cordisxHomeDir = await temporary()
    const homedir = await temporary()
    const dataDir = path.join(cordisxHomeDir, 'data-3p')
    const directory = path.join(dataDir, 'claude-code', '2.1.309', 'build', 'claude.app', 'Contents', 'MacOS')
    await mkdir(directory, { recursive: true })
    const binary = path.join(directory, 'claude')
    // A turn that outlives the report window, as a real multi-minute task does.
    await writeFile(binary, '#!/bin/sh\nsleep 0.4\n')
    await chmod(binary, 0o755)
    await writeClaudeDesktopBinding(cordisxHomeDir, {
      version: 1,
      profileId: 'e2e',
      homeDir: cordisxHomeDir,
      dataDir,
    })
    const sessions = createClaudeHostSessions({
      cordisxHomeDir,
      homedir,
      runningPid: async () => -1,
      secret: async () => undefined,
      turnReportMs: 200,
    })
    const before = Date.now()
    const started = await sessions('start_session', { prompt: 'long job' }) as Record<string, string>
    expect(Date.now() - before).toBeLessThan(5_000)
    expect(started).toMatchObject({ status: 'started' })
    expect(started.turn).toBeUndefined()
    expect(await sessions('send_message', { sessionId: started.sessionId, prompt: 'duplicate' })).toMatchObject({
      reason: 'session-busy',
    })
    expect(started.note).toMatch(/background/u)
    expect(await sessions('check_operation', { operationId: started.operationId })).toMatchObject({ status: 'running' })
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(await sessions('check_operation', { operationId: started.operationId })).toMatchObject({ status: 'done' })
  }, 30_000)

  it('resumes a closed session for a message and hands an open one to its plugin', async () => {
    const { cordisxHomeDir, homedir, dataDir, record } = await launched()
    const folder = path.join(dataDir, 'claude-code-sessions', 'account', 'org')
    await mkdir(folder, { recursive: true })
    await writeFile(
      path.join(folder, `local_${CLI_ID}.json`),
      JSON.stringify({
        sessionId: `local_${CLI_ID}`,
        cliSessionId: CLI_ID,
        cwd: homedir,
        model: 'claude-sonnet-5-5',
      }),
    )
    let open = ''
    const forwarded: unknown[] = []
    const sessions = createClaudeHostSessions({
      cordisxHomeDir,
      homedir,
      secret: async () => 'sk-test',
      runningPid: async () => -1,
      processList: async () => open,
      viaPlugin: async (operation, args, target) => {
        forwarded.push([operation, args, target])
        return { status: 'sent' }
      },
    })

    expect(await sessions('send_message', { sessionId: CLI_ID, prompt: 'And the CHANGELOG' })).toEqual(
      expect.objectContaining({
        status: 'sent',
        sessionId: `local_${CLI_ID}`,
        link: `claude://resume?session=${CLI_ID}`,
      }),
    )
    await until(`${record}.cwd`)
    expect((await until(`${record}.args`)).trim().split('\n')).toEqual(expect.arrayContaining([
      '--resume',
      CLI_ID,
      '--model',
      'claude-sonnet-5-5',
    ]))

    open = `/claude --resume ${CLI_ID}`
    expect(await sessions('send_message', { sessionId: `local_${CLI_ID}`, prompt: 'hi' })).toMatchObject({
      status: 'sent',
    })
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

describe('a closed Claude', () => {
  it('asks first, starts on "once" or "always", and remembers "always"', async () => {
    const cordisxHomeDir = await temporary()
    const homedir = await temporary()
    const dataDir = path.join(cordisxHomeDir, 'data-3p')
    const record = path.join(cordisxHomeDir, 'turn')
    await fakeCli(dataDir, '2.1.309', record)
    const launches: unknown[] = []
    const pidFile = path.join(cordisxHomeDir, 'apps', 'claude', 'profiles', 'e2e', 'claude.pid')
    const sessions = createClaudeHostSessions({
      cordisxHomeDir,
      homedir,
      secret: async () => 'sk-test',
      processList: async () => '',
      launchWaitMs: 1,
      launchClaude: async request => {
        launches.push(request)
        await writeClaudeDesktopBinding(cordisxHomeDir, {
          version: 1,
          profileId: 'e2e',
          homeDir: cordisxHomeDir,
          dataDir,
        })
        await mkdir(path.dirname(pidFile), { recursive: true })
      },
    })

    const asked = await sessions('start_session', { prompt: 'x' }) as Record<string, string>
    expect(asked).toEqual(expect.objectContaining({ status: 'needs-confirmation', reason: 'claude-not-running' }))
    expect(launches).toEqual([])

    // The fake launch leaves no running process, so the wait ends in a failure; it did launch.
    expect(await sessions('start_session', { prompt: 'x', launch: 'always' })).toEqual(expect.objectContaining({
      status: 'failed',
      reason: 'claude-did-not-start',
      retryable: true,
    }))
    expect(launches).toEqual([{ homeDir: cordisxHomeDir, profileId: 'default' }])
    expect(JSON.parse(await readFile(claudeLaunchPreferencePath(cordisxHomeDir), 'utf8'))).toEqual({ launch: 'always' })

    await sessions('start_session', { prompt: 'x', launch: 'ask' })
    expect(JSON.parse(await readFile(claudeLaunchPreferencePath(cordisxHomeDir), 'utf8'))).toEqual({ launch: 'ask' })
  }, 80_000)

  it('reads a closed profile from its files without asking', async () => {
    const cordisxHomeDir = await temporary()
    await writeClaudeDesktopBinding(cordisxHomeDir, {
      version: 1,
      profileId: 'e2e',
      homeDir: cordisxHomeDir,
      dataDir: path.join(cordisxHomeDir, 'data-3p'),
    })
    const sessions = createClaudeHostSessions({
      cordisxHomeDir,
      homedir: await temporary(),
      secret: async () => undefined,
    })
    expect(await sessions('list_sessions', {})).toEqual({ running: false, sessions: [] })
  })
})
