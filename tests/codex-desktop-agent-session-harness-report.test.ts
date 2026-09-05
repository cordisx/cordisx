import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  desktopAgentSessionRendererTimeoutMs,
  waitForOwnedProfileQuiescence,
  writeDesktopAgentSessionHarnessReport,
} from '../packages/cli/scripts/desktop-agent-session-harness-report.mjs'

describe('Codex Desktop Agent Session harness report', () => {
  it('keeps the ordinary renderer timeout and bounds the Desktop harness at 120 seconds', () => {
    expect(desktopAgentSessionRendererTimeoutMs(false)).toBe(30_000)
    expect(desktopAgentSessionRendererTimeoutMs(true)).toBe(120_000)
  })

  it('atomically creates a fallback report and then annotates a real smoke report', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-desktop-harness-report-'))
    try {
      const reportPath = path.join(root, 'nested', 'report.json')
      await expect(writeDesktopAgentSessionHarnessReport(
        reportPath,
        {
          schemaVersion: 1,
          kind: 'codex-desktop-agent-session-live-smoke',
          result: 'failed',
          error: 'renderer timeout',
          renderer: { url: 'app://-/index.html', ready: false, fixtureReady: false },
          bridge: { instrumentation: false, observationMode: 'unavailable' },
          operations: [],
          stages: [],
        },
        { stages: [{ stage: 'launch-started', elapsedMs: 0 }], portClosed: true },
      )).resolves.toEqual({ fallbackCreated: true })
      expect(JSON.parse(await readFile(reportPath, 'utf8'))).toMatchObject({
        result: 'failed',
        error: 'renderer timeout',
        renderer: { ready: false, fixtureReady: false },
        bridge: { instrumentation: false, observationMode: 'unavailable' },
        harness: { stages: [{ stage: 'launch-started', elapsedMs: 0 }], portClosed: true },
      })
      expect((await readdir(path.dirname(reportPath))).filter(name => name.endsWith('.tmp'))).toEqual([])

      await writeFile(reportPath, '{"schemaVersion":1,"result":"partial"}\n')
      await expect(writeDesktopAgentSessionHarnessReport(
        reportPath,
        { schemaVersion: 1, result: 'failed' },
        { stages: [{ stage: 'renderer-ready', elapsedMs: 12 }], portClosed: true },
      )).resolves.toEqual({ fallbackCreated: false })
      expect(JSON.parse(await readFile(reportPath, 'utf8'))).toMatchObject({
        result: 'partial',
        harness: { stages: [{ stage: 'renderer-ready', elapsedMs: 12 }] },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('allows exact-profile helpers a bounded settle window before cleanup readback', async () => {
    const snapshots = [[{ pid: 1 }], [{ pid: 2 }], []]
    const read = () => snapshots.shift() ?? []
    await expect(waitForOwnedProfileQuiescence(read, { timeoutMs: 50, intervalMs: 1 })).resolves.toEqual([])
  })
})
