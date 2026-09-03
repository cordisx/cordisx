import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  desktopAgentSessionRendererTimeoutMs,
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
        { schemaVersion: 1, result: 'failed', error: 'renderer timeout' },
        { stages: [{ stage: 'launch-started', elapsedMs: 0 }], portClosed: true },
      )).resolves.toEqual({ fallbackCreated: true })
      expect(JSON.parse(await readFile(reportPath, 'utf8'))).toMatchObject({
        result: 'failed', error: 'renderer timeout',
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
        result: 'partial', harness: { stages: [{ stage: 'renderer-ready', elapsedMs: 12 }] },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
