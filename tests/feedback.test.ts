import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { parseCordisXCli } from '../packages/cli/src/cli/parse.js'
import { runCordisXCli } from '../packages/cli/src/cli/run-command.js'
import { supervisorPaths, writeSupervisorState } from '../packages/cli/src/cli/supervisor-state.js'
import {
  exportFeedbackBundle,
  inspectFeedbackArchive,
  inspectFeedbackBundle,
} from '../packages/cli/src/feedback/archive.js'
import { redactFeedbackText } from '../packages/cli/src/feedback/redaction.js'
import { safeDiagnosticMessage } from '../packages/cli/src/launcher/diagnostic-redaction.js'

function config(): unknown {
  return {
    version: 1,
    defaultApp: 'codex',
    providers: [],
    plugins: [{ id: 'sample', entry: '/private/plugin.js' }],
    permissions: [],
    publisherGrantIssuers: [],
    marketplaceSources: [{ url: 'https://example.test/marketplace.json', enabled: true, trusted: false }],
    apps: {
      codex: { defaultProfile: 'default', profiles: { default: { displayName: 'Default', dataMode: 'shared' } } },
    },
  }
}

describe('CordisX feedback', () => {
  it('redacts secrets, URLs, and paths centrally', () => {
    const result = redactFeedbackText(
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz https://example.test/a?token=x /Users/alice/project',
      ['/Users/alice'],
    )
    expect(result.text).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(result.text).not.toContain('example.test')
    expect(result.text).not.toContain('alice')
    expect(result.counts.secret).toBeGreaterThan(0)
    expect(result.counts.url).toBeGreaterThan(0)
    expect(result.counts.path).toBeGreaterThan(0)
    expect(safeDiagnosticMessage(
      new Error(
        'failed at C:\\Users\\alice\\plugin.js from https://example.test token=secret-value',
      ),
    )).toBe('failed at [path redacted] from [url redacted] token=[redacted]')
  })

  it('collects a bounded legacy bundle with partial correlation and preserves recovered readiness semantics', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-feedback-'))
    const output = path.join(root, 'bundle')
    const lines: string[] = []
    try {
      await writeFile(path.join(root, 'config.json'), JSON.stringify(config()))
      const paths = supervisorPaths(root, 'codex', 'default')
      await writeSupervisorState(paths, {
        schemaVersion: 1,
        appId: 'codex',
        profileId: 'default',
        phase: 'ready',
        pid: process.pid,
        processStartedAt: 'unknown',
        instanceToken: 'a'.repeat(32),
        createdAt: new Date().toISOString(),
        version: '0.1.0',
        effectiveConfig: 'x',
      })
      await writeFile(
        paths.log,
        `${
          'repeat '.repeat(200_000)
        }\ncdp target-list fetch failed\nrenderer install ready\nrenderer injected\nAuthorization: Bearer ${
          'x'.repeat(48)
        }\nhttps://example.test/path?secret=yes\n/Users/alice/private\n`,
      )
      await runCordisXCli(['feedback', 'collect', '--output', output, '--max-bytes', '524288', '--json'], {
        env: { CORDISX_HOME: root },
        stdout: line => lines.push(line),
      })
      const result = JSON.parse(lines[0]!) as { readonly bundlePath: string }
      const manifest = await inspectFeedbackBundle(result.bundlePath)
      const schema = JSON.parse(
        await readFile(
          path.join(process.cwd(), 'packages/cli/assets/feedback/feedback-manifest.schema.json'),
          'utf8',
        ),
      ) as object
      const ajv = new Ajv2020({ strict: false })
      addFormats(ajv)
      const validate = ajv.compile(schema)
      expect(validate(manifest)).toBe(true)
      expect(manifest.selection.correlationConfidence).toBe('partial')
      expect(manifest.selection.disposition).toBe('ready')
      expect(manifest.artifacts.find(item => item.path === 'diagnostics/host-log.txt')?.status).toBe('truncated')
      const log = await readFile(path.join(output, 'diagnostics', 'host-log.txt'), 'utf8')
      expect(log).not.toContain('example.test')
      expect(log).not.toContain('/Users/alice')
      expect(log).not.toContain('x'.repeat(48))
      const supervisor = JSON.parse(
        await readFile(path.join(output, 'diagnostics', 'supervisor.json'), 'utf8'),
      ) as { readonly supervisor: { readonly processIdentity: string; readonly statePrivate: boolean } }
      expect(supervisor.supervisor.processIdentity).toBe('unknown')
      expect(supervisor.supervisor.statePrivate).toBe(true)
      const doctor = JSON.parse(await readFile(path.join(output, 'diagnostics', 'doctor.json'), 'utf8')) as {
        readonly status: string
        readonly target: unknown
        readonly executable?: string
      }
      expect(doctor.status).toMatch(/^(?:available|unavailable)$/u)
      expect(doctor.target).toBeDefined()
      expect(doctor.executable).toBeUndefined()
      const plugins = JSON.parse(await readFile(path.join(output, 'diagnostics', 'plugins.json'), 'utf8')) as readonly {
        readonly sourceRef: string
        readonly sourceClass: string
        readonly entry?: string
      }[]
      expect(plugins[0]).toMatchObject({
        sourceRef: expect.stringMatching(/^plugin-source_[a-f0-9]{32}$/u),
        sourceClass: 'path',
      })
      expect(plugins[0]?.entry).toBeUndefined()
      if (process.platform !== 'win32') {
        expect((await stat(output)).mode & 0o777).toBe(0o700)
        expect((await stat(path.join(output, 'manifest.json'))).mode & 0o777).toBe(0o600)
      }

      const secondOutput = path.join(root, 'bundle-two')
      await runCordisXCli(['feedback', 'collect', '--output', secondOutput, '--json'], {
        env: { CORDISX_HOME: root },
        stdout: () => undefined,
      })
      const second = await inspectFeedbackBundle(secondOutput)
      expect(second.target.profile.ref).not.toBe(manifest.target.profile.ref)
      expect(second.selection.launchId).not.toBe(manifest.selection.launchId)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports cleanup degradation after ready and rejects tampered bundle artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-feedback-'))
    const output = path.join(root, 'bundle')
    try {
      await writeFile(path.join(root, 'config.json'), JSON.stringify(config()))
      const paths = supervisorPaths(root, 'codex', 'default')
      await import('node:fs/promises').then(({ mkdir }) => mkdir(paths.directory, { recursive: true }))
      await writeFile(paths.log, 'renderer ready\nrenderer injected\ncleanup incomplete\n')
      await runCordisXCli(['feedback', 'collect', '--output', output, '--json'], {
        env: { CORDISX_HOME: root },
        stdout: () => undefined,
      })
      const manifest = await inspectFeedbackBundle(output)
      expect(manifest.selection.disposition).toBe('ready_then_cleanup_degraded')
      await writeFile(path.join(output, 'diagnostics', 'host-log.txt'), 'tampered')
      await expect(inspectFeedbackBundle(output)).rejects.toThrow('integrity check failed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('exports only an inspected stage into a local archive', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-feedback-'))
    const output = path.join(root, 'bundle')
    try {
      await writeFile(path.join(root, 'config.json'), JSON.stringify(config()))
      await runCordisXCli(['feedback', 'collect', '--output', output, '--json'], {
        env: { CORDISX_HOME: root },
        stdout: () => undefined,
      })
      const archive = path.join(root, 'feedback.zip')
      await expect(exportFeedbackBundle(output, archive)).resolves.toMatchObject({
        bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      })
      await expect(inspectFeedbackArchive(archive)).resolves.toMatchObject({ bundleId: expect.stringMatching(/^fb_/u) })
      await writeFile(archive, 'tampered archive')
      await expect(inspectFeedbackArchive(archive)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes an unpublished stage when collection fails privacy-safe input validation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-feedback-'))
    const output = path.join(root, 'bundle')
    try {
      await writeFile(path.join(root, 'config.json'), JSON.stringify(config()))
      const oversizedDescription = path.join(root, 'description.txt')
      await writeFile(oversizedDescription, 'x'.repeat(8_193))
      await expect(runCordisXCli([
        'feedback',
        'collect',
        '--output',
        output,
        '--description-file',
        oversizedDescription,
        '--json',
      ], { env: { CORDISX_HOME: root }, stdout: () => undefined })).rejects.toThrow('description_file_too_large')
      await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readdir(root)).some(entry => entry.startsWith('.bundle.') && entry.endsWith('.tmp'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses non-persisted defaults when config is absent and preserves an explicit output parent mode', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-feedback-home-'))
    const parent = await mkdtemp(path.join(os.tmpdir(), 'cordisx-feedback-output-'))
    const output = path.join(parent, 'bundle')
    try {
      if (process.platform !== 'win32') await chmod(parent, 0o755)
      await runCordisXCli(['feedback', 'collect', '--output', output, '--json'], {
        env: { CORDISX_HOME: home },
        stdout: () => undefined,
      })
      const manifest = await inspectFeedbackBundle(output)
      expect(manifest.missing).toContainEqual({
        field: 'home_config',
        status: 'missing',
        reason: 'not_found_using_defaults',
      })
      await expect(stat(path.join(home, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      if (process.platform !== 'win32') expect((await stat(parent)).mode & 0o777).toBe(0o755)
    } finally {
      await Promise.all([
        rm(home, { recursive: true, force: true }),
        rm(parent, { recursive: true, force: true }),
      ])
    }
  })
})
