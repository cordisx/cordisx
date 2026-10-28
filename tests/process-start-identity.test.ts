import { execFile, execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  compareProcessStartTimes,
  processIdentityEnvironment,
} from '../packages/cli/src/launcher/process-start-identity.js'
import { liveProcessStartedAt, recordedProcessStatus } from '../packages/cli/src/launcher/process-identity.js'
import { processIdentityStatus, processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'

const fixture = vi.hoisted(() => ({ present: true, failure: false }))
const canonical = 'Tue Oct 27 20:38:49 2026'
const localized = '二 10月/27 20:38:49 2026'
const anotherStart = 'Tue Nov  3 20:38:49 2026'
const absentPid = 2_147_483_647

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  type Options = { env?: NodeJS.ProcessEnv }
  type Callback = (error: Error | null, stdout: string, stderr: string) => void
  const output = (options?: Options): string => {
    if (fixture.failure) throw new Error('synthetic ps failure')
    if (!fixture.present) return ''
    const environment = options?.env ?? process.env
    return environment.LC_ALL === 'C'
      ? 'Tue Oct 27 20:38:49 2026'
      : '二 10月/27 20:38:49 2026'
  }
  return {
    ...actual,
    execFileSync: vi.fn((file: string, args: readonly string[], options?: Options) => {
      if (file !== 'ps' || !args.includes('pid=,ppid=,lstart=')) throw new Error('unexpected fixture command')
      const start = output(options)
      return start === '' ? '' : '  ' + process.pid + ' 1 ' + start + '\n'
    }),
    execFile: vi.fn((file: string, args: readonly string[], options: Options | Callback, callback?: Callback) => {
      const done = typeof options === 'function' ? options : callback!
      try {
        if (file !== 'ps' || !args.includes('lstart=')) throw new Error('unexpected fixture command')
        done(null, output(typeof options === 'function' ? undefined : options) + '\n', '')
      } catch (error) {
        done(error as Error, '', '')
      }
      return {} as import('node:child_process').ChildProcess
    }),
  }
})

beforeEach(() => {
  fixture.present = true
  fixture.failure = false
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('locale-independent start-time comparison', () => {
  it('matches complete C and confirmed Darwin Chinese identities in either direction', () => {
    expect(compareProcessStartTimes(canonical, localized)).toBe('alive')
    expect(compareProcessStartTimes(localized, canonical)).toBe('alive')
    expect(compareProcessStartTimes(canonical, canonical)).toBe('alive')
    expect(compareProcessStartTimes(localized, localized)).toBe('alive')
  })

  it('rejects genuinely different valid start times instead of trusting only the PID', () => {
    expect(compareProcessStartTimes(canonical, anotherStart)).toBe('dead')
    expect(compareProcessStartTimes(canonical, '二 10月/27 20:38:48 2026')).toBe('dead')
    expect(compareProcessStartTimes(canonical, 'Tue Oct 27 20:38:49 2020')).toBe('dead')
  })

  it.each([
    '',
    'another start time',
    'Tue Oct 27 20:38:49 2026 trailing',
    'Mon Oct 27 20:38:49 2026',
    '一 10月/27 20:38:49 2026',
    'Tue Feb 30 20:38:49 2026',
    '二 13月/27 20:38:49 2026',
    '二 10月/00 20:38:49 2026',
    'Tue Oct 27 24:38:49 2026',
    '二 10月/27 20:60:49 2026',
    'Tue Oct 27 20:38:60 2026',
    'Di Okt 27 20:38:49 2026',
  ])('keeps unsupported or invalid identity %j unknown, even when strings are identical', value => {
    expect(compareProcessStartTimes(canonical, value)).toBe('unknown')
    expect(compareProcessStartTimes(value, canonical)).toBe('unknown')
    expect(compareProcessStartTimes(value, value)).toBe('unknown')
  })
})

describe.skipIf(process.platform === 'win32')('identity collection through both ps paths', () => {
  it.each(['C', 'zh_CN.UTF-8'])('pins child LC_ALL while preserving inherited %s environment', async locale => {
    vi.stubEnv('LANG', locale)
    vi.stubEnv('LC_ALL', locale)
    vi.stubEnv('LC_TIME', 'zh_CN.UTF-8')
    vi.stubEnv('CORDISX_IDENTITY_FIXTURE', 'preserved')
    const environment = processIdentityEnvironment()
    expect(environment).not.toBe(process.env)
    expect(environment).toMatchObject({
      LC_ALL: 'C',
      LANG: locale,
      LC_TIME: 'zh_CN.UTF-8',
      CORDISX_IDENTITY_FIXTURE: 'preserved',
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    })
    expect(process.env.LC_ALL).toBe(locale)
    expect(liveProcessStartedAt(process.pid)).toBe(canonical)
    expect(await processStartIdentity(process.pid)).toBe(canonical)
    const expectedOptions = expect.objectContaining({
      env: expect.objectContaining({ LC_ALL: 'C', LANG: locale, CORDISX_IDENTITY_FIXTURE: 'preserved' }),
    })
    expect(execFileSync).toHaveBeenCalledWith('ps', ['-axo', 'pid=,ppid=,lstart='], expectedOptions)
    expect(execFile).toHaveBeenCalledWith(
      'ps',
      ['-o', 'lstart=', '-p', String(process.pid)],
      expectedOptions,
      expect.any(Function),
    )
    expect(recordedProcessStatus(process.pid, canonical)).toBe('alive')
    expect(await processIdentityStatus(process.pid, canonical)).toBe('alive')
    expect(process.env.LC_ALL).toBe(locale)
  })

  it('recognizes valid legacy Chinese records under a different inherited locale', async () => {
    vi.stubEnv('LC_ALL', 'C')
    expect(recordedProcessStatus(process.pid, localized)).toBe('alive')
    expect(await processIdentityStatus(process.pid, localized)).toBe('alive')
  })

  it('reports a reused PID with a different valid start time dead through both paths', async () => {
    expect(recordedProcessStatus(process.pid, anotherStart)).toBe('dead')
    expect(await processIdentityStatus(process.pid, anotherStart)).toBe('dead')
  })

  it('keeps an unsupported legacy record unknown rather than authorizing reclamation', async () => {
    expect(recordedProcessStatus(process.pid, 'unsupported old locale')).toBe('unknown')
    expect(await processIdentityStatus(process.pid, 'unsupported old locale')).toBe('unknown')
  })

  it('reports an absent PID dead without attempting an unsafe identity match', async () => {
    fixture.present = false
    expect(recordedProcessStatus(absentPid, canonical)).toBe('dead')
    expect(await processIdentityStatus(absentPid, canonical)).toBe('dead')
    expect(execFile).not.toHaveBeenCalled()
  })

  it('reports ps failure unknown for a live PID in both paths', async () => {
    fixture.failure = true
    expect(recordedProcessStatus(process.pid, canonical)).toBe('unknown')
    expect(await processIdentityStatus(process.pid, canonical)).toBe('unknown')
  })

  it('keeps an empty single-PID ps response unknown when the PID remains live', async () => {
    fixture.present = false
    expect(await processIdentityStatus(process.pid, canonical)).toBe('unknown')
  })
})
