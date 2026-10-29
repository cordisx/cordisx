import { mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { diagnostic, diagnosticError, withDiagnostics } from './context.js'
import { JOURNAL_RETENTION_MS, LocalJournal, maintainJournal, projectDiagnostic, readJournal } from './journal.js'
const roots: string[] = []
async function root() {
  const value = await mkdtemp(path.join(os.tmpdir(), 'cx-journal-'))
  roots.push(value)
  return value
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true })))
})
describe('private local diagnostic journal', () => {
  it('rotates, atomically compresses and reads a 72-hour chain across concurrent writers', async () => {
    const directory = await root(), start = Date.now()
    let now = start
    const first = new LocalJournal({ directory, version: 'test', segmentBytes: 300, now: () => now })
    const second = new LocalJournal({ directory, version: 'test', segmentBytes: 300, now: () => now })
    withDiagnostics(first, () => {
      for (let count = 0; count < 8; count++) diagnostic({ event: 'launch-failed', count })
    })
    second.emit({ event: 'runtime-generation', generation: 'test-generation', hostVersion: '1.2.3' })
    second.emit({ event: 'model-failed', provider: 'example', model: 'test-model' })
    await Promise.all([first.close(), second.close()])
    const names = await readdir(directory)
    expect(names.some(name => name.endsWith('.tmp'))).toBe(false)
    expect(names.filter(name => name.endsWith('.gz')).length).toBeGreaterThan(2)
    for (const name of names) {
      expect((await stat(path.join(directory, name))).mode & 0o077).toBe(0)
      if (name.endsWith('.gz')) {
        expect(gunzipSync(await readFile(path.join(directory, name))).toString()).toContain('schemaVersion')
      }
    }
    now += JOURNAL_RETENTION_MS - 1000
    await Promise.all([maintainJournal(directory, now), maintainJournal(directory, now)])
    const result = await readJournal(directory, { from: start - 1, until: now, maxBytes: 65536 })
    expect(result.text.match(/launch-failed/gu)).toHaveLength(8)
    expect(result.text).toContain('model-failed')
    expect(JSON.parse(result.text.split('\n').find(line => line.includes('model-failed'))!)).toMatchObject({
      generation: 'test-generation',
      hostVersion: '1.2.3',
    })
    expect(result.truncated).toBe(false)
    now += 5000
    await maintainJournal(directory, now)
    expect(await readdir(directory)).toEqual([])
  })
  it('recovers a crashed shard but leaves an active process shard untouched', async () => {
    const directory = await root(), now = Date.now()
    const crashed = `${now}-2147483647-aaaaaaaa.active.jsonl`
    const active = `${now}-${process.pid}-bbbbbbbb.active.jsonl`
    const line = JSON.stringify({ schemaVersion: 1, at: now, event: 'launch-failed' }) + '\n'
    await writeFile(path.join(directory, crashed), line, { mode: 0o600 })
    await writeFile(path.join(directory, active), line, { mode: 0o600 })
    await maintainJournal(directory, now)
    expect(await readdir(directory)).toEqual(expect.arrayContaining([`${crashed}.gz`, active]))
    const limited = await readJournal(directory, { from: now - 1, until: now, maxBytes: 16 })
    expect(limited.truncated).toBe(true)
    expect(limited.text).toBe('')
  })
  it('expires by final event time, preserves recent evidence at disk bounds and reports gaps', async () => {
    const directory = await root(), now = Date.now(), warn = vi.fn()
    const oldName = `${now - JOURNAL_RETENTION_MS - 1000}-2147483647-aaaaaaaa.sealed.jsonl`
    await writeFile(path.join(directory, oldName), JSON.stringify({ at: now, event: 'failure' }) + '\n')
    await maintainJournal(directory, now)
    expect((await readdir(directory)).length).toBe(1)
    const writer = new LocalJournal({ directory, version: 'test', diskBytes: 400, warn })
    for (let count = 0; count < 20; count++) writer.emit({ event: 'model-failed', count })
    await writer.close()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('diagnostic-evidence-gap'))
    expect((await readdir(directory)).some(name => name.startsWith('evidence-gap-'))).toBe(true)
    expect((await readdir(directory)).some(name => name.startsWith(oldName))).toBe(true)
  })
  it('contains no unknown fields or raw error, header, environment or content values', () => {
    expect(
      projectDiagnostic({
        event: 'model-failed',
        token: 'secret',
        headers: 'secret',
        body: 'chat',
        environment: 'secret',
        reason: 'user text with spaces',
        model: 'gpt-example',
        statusCode: 503,
      }),
    ).toEqual({ event: 'model-failed', model: 'gpt-example', statusCode: 503 })
    expect(diagnosticError(new Error('prompt and token=private', { cause: { code: 'ECONNRESET' } }))).toEqual({
      errorCode: 'ECONNRESET',
      errorClass: 'network',
    })
    expect(JSON.stringify(diagnosticError({ code: 'secret-value' }))).not.toContain('secret-value')
  })
  it('does not break product work when the destination is unwritable or a symlink', async () => {
    const directory = await root(), warn = vi.fn()
    const file = path.join(directory, 'file')
    await writeFile(file, '')
    const writer = new LocalJournal({ directory: path.join(file, 'invalid'), version: 'test', warn })
    let executed = false
    withDiagnostics(writer, () => {
      diagnostic({ event: 'launch-failed' })
      executed = true
    })
    await writer.close()
    expect(executed).toBe(true)
    expect(warn).toHaveBeenCalled()
    const target = path.join(directory, 'link')
    await symlink(directory, target)
    const linked = new LocalJournal({ directory: target, version: 'test', warn })
    await linked.close()
    expect((await readdir(directory)).filter(name => name.endsWith('.jsonl.gz'))).toEqual([])
  })
})
