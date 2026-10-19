import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'
import * as bootstrapModule from '../packages/cli/src/cli/production-host-bootstrap.js'
import * as rendererModule from '../packages/cli/src/cli/renderer-composition.js'
import * as supervisorModule from '../packages/cli/src/cli/supervisor-runtime.js'

it.each([false, true])('observes early native failure and drains cleanup (renderer fails: %s)', async rendererFails => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-native-startup-failure-'))
  const nativeError = new Error('Native capability wire-normalizer: unsupported request source')
  const rendererError = new Error('renderer assembly failed')
  const markFailed = vi.fn(async () => undefined)
  const closeBootstrap = vi.fn(async () => undefined)
  const closeRenderer = vi.fn(async () => undefined)
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
    const expected = rendererFails ? rendererError : nativeError
    await expect(runCordisXCli(['run', 'codex', '--executable', process.execPath], {
      env: { CORDISX_HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex') },
      internalNativeSubmissionPlatform: 'darwin',
      internalRunInjectedHost: runHost,
      stdout: () => undefined,
    })).rejects.toBe(expected)
    expect(markFailed).toHaveBeenCalledWith(expected.message)
    expect(closeBootstrap).toHaveBeenCalledTimes(1)
    expect(closeRenderer).toHaveBeenCalledTimes(rendererFails ? 0 : 1)
    expect(runHost).not.toHaveBeenCalled()
  } finally {
    bootstrapSpy.mockRestore()
    rendererSpy.mockRestore()
    supervisorSpy.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
