import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'
import { NativeSubmissionCompatibilityError } from '../packages/cli/src/launcher/native-submission-composition.js'
import * as bootstrapModule from '../packages/cli/src/cli/production-host-bootstrap.js'
import * as rendererModule from '../packages/cli/src/cli/renderer-composition.js'
import * as supervisorModule from '../packages/cli/src/cli/supervisor-runtime.js'

it.each([false, true])(
  'isolates early native failure and drains cleanup (renderer fails: %s)',
  async rendererFails => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-native-startup-failure-'))
    const nativeError = new Error('Native capability wire-normalizer: unsupported request source')
    const rendererError = new Error('renderer assembly failed')
    const output: string[] = []
    const markFailed = vi.fn(async () => undefined)
    const closeBootstrap = vi.fn(async () => undefined)
    const closeRenderer = vi.fn(async () => undefined)
    const runHost = vi.fn()
    const retryNativeSubmission = vi.fn()
    const prepare = bootstrapModule.prepareProductionHostBootstrap
    const bootstrapSpy = vi.spyOn(bootstrapModule, 'prepareProductionHostBootstrap').mockImplementation(
      async (...args) => ({
        ...await prepare(...args),
        nativeSubmissionUnavailable: undefined,
        nativeSubmissionBootstrap: {
          environment: {
            CODEX_CLI_PATH: '/tmp/cordisx-native-intermediary',
            CORDISX_NATIVE_CONTROL_SOCKET: '/tmp/cordisx-native-control',
          },
          complete: async () => {
            throw new NativeSubmissionCompatibilityError(nativeError)
          },
          close: closeBootstrap,
        },
      }),
    )
    const rendererSpy = vi.spyOn(rendererModule, 'buildRendererComposition').mockImplementation(async () => {
      // Native rejection precedes the consumer's await by an event-loop turn.
      await new Promise(resolve => setTimeout(resolve, 25))
      if (rendererFails) throw rendererError
      return {
        source: '',
        authoritySource: () => '',
        hasLoopbackGraph: false,
        agentHistoryBridgeToken: 'test-history-token',
        ownerDocumentSecret: 'test-secret',
        generation: 'test-generation',
        rebuild: async () => ({ source: '' }),
        close: closeRenderer,
      }
    })
    const supervisorSpy = vi.spyOn(supervisorModule, 'createSupervisorRuntime').mockResolvedValue({
      markFailed,
      markReady: vi.fn(),
      markHostLaunched: vi.fn(),
      close: vi.fn(),
      mainInspector: false,
    })
    try {
      const operation = runCordisXCli(['run', 'codex', '--executable', process.execPath], {
        env: { CORDISX_HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex') },
        internalCreateNativeSubmissionComposition: retryNativeSubmission,
        internalNativeSubmissionPlatform: 'darwin',
        internalRunInjectedHost: runHost,
        stdout: line => output.push(line),
      })
      if (rendererFails) {
        await expect(operation).rejects.toBe(rendererError)
        expect(markFailed).toHaveBeenCalledWith(rendererError.message)
      } else {
        await expect(operation).resolves.toBeUndefined()
        expect(markFailed).not.toHaveBeenCalled()
      }
      expect(closeBootstrap).toHaveBeenCalledTimes(1)
      expect(closeRenderer).toHaveBeenCalledTimes(rendererFails ? 0 : 1)
      expect(runHost).toHaveBeenCalledTimes(rendererFails ? 0 : 1)
      if (!rendererFails) {
        expect(runHost).toHaveBeenCalledWith(expect.not.objectContaining({ nativeSubmission: expect.anything() }))
        expect(runHost).toHaveBeenCalledWith(expect.objectContaining({
          environment: expect.not.objectContaining({
            CODEX_CLI_PATH: expect.anything(),
            CORDISX_NATIVE_CONTROL_SOCKET: expect.anything(),
          }),
        }))
        expect(retryNativeSubmission).not.toHaveBeenCalled()
        expect(output).toContainEqual(expect.stringContaining('native Desktop model providers unavailable'))
      }
    } finally {
      bootstrapSpy.mockRestore()
      rendererSpy.mockRestore()
      supervisorSpy.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  },
)

it('keeps unexpected native completion failures terminal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-native-startup-unexpected-'))
  const nativeError = new Error('native controller binding failed')
  const markFailed = vi.fn(async () => undefined)
  const closeBootstrap = vi.fn(async () => undefined)
  const runHost = vi.fn()
  const prepare = bootstrapModule.prepareProductionHostBootstrap
  const bootstrapSpy = vi.spyOn(bootstrapModule, 'prepareProductionHostBootstrap').mockImplementation(
    async (...args) => ({
      ...await prepare(...args),
      nativeSubmissionBootstrap: {
        environment: {},
        complete: async () => {
          throw nativeError
        },
        close: closeBootstrap,
      },
    }),
  )
  const supervisorSpy = vi.spyOn(supervisorModule, 'createSupervisorRuntime').mockResolvedValue({
    markFailed,
    markReady: vi.fn(),
    markHostLaunched: vi.fn(),
    close: vi.fn(),
    mainInspector: false,
  })
  try {
    await expect(runCordisXCli(['run', 'codex', '--executable', process.execPath], {
      env: { CORDISX_HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex') },
      internalNativeSubmissionPlatform: 'darwin',
      internalRunInjectedHost: runHost,
      stdout: () => undefined,
    })).rejects.toBe(nativeError)
    expect(markFailed).toHaveBeenCalledWith(nativeError.message)
    expect(closeBootstrap).toHaveBeenCalledTimes(1)
    expect(runHost).not.toHaveBeenCalled()
  } finally {
    bootstrapSpy.mockRestore()
    supervisorSpy.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

it('does not retry native submission after bootstrap preparation declares it unavailable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-native-bootstrap-unavailable-'))
  const retryNativeSubmission = vi.fn()
  const runHost = vi.fn()
  const prepare = bootstrapModule.prepareProductionHostBootstrap
  const bootstrapSpy = vi.spyOn(bootstrapModule, 'prepareProductionHostBootstrap').mockImplementation(
    async (...args) => ({
      ...await prepare(...args),
      nativeSubmissionUnavailable: true,
      nativeSubmissionBootstrap: undefined,
    }),
  )
  try {
    await runCordisXCli(['run', 'codex', '--executable', process.execPath], {
      env: { CORDISX_HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex') },
      internalCreateNativeSubmissionComposition: retryNativeSubmission,
      internalNativeSubmissionPlatform: 'darwin',
      internalRunInjectedHost: runHost,
      stdout: () => undefined,
    })
    expect(retryNativeSubmission).not.toHaveBeenCalled()
    expect(runHost).toHaveBeenCalledTimes(1)
    expect(runHost).toHaveBeenCalledWith(expect.not.objectContaining({ nativeSubmission: expect.anything() }))
  } finally {
    bootstrapSpy.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
