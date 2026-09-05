import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  PLAYGROUND_PREVIEW_RESET_APPLIED_KEY,
  PLAYGROUND_PREVIEW_RESET_MARKER_KEY,
  PLAYGROUND_PREVIEW_RESET_RESULT_KEY,
  playgroundPreviewResetDisposition,
  type PlaygroundPreviewResetResult,
  readPlaygroundPreviewResetApplied,
  readPlaygroundPreviewResetMarker,
  reconcilePlaygroundPreviewBootstrapEpoch,
} from '../packages/cli/src/playground/client/preview-reset.js'
import {
  countPlaygroundSimulatorSessionRecords,
  PLAYGROUND_SIMULATOR_TASK_SNAPSHOT_KEY,
} from '../packages/cli/src/playground/client/task-details-navigation.js'

function resetReadback(
  simulatorRecords: number,
): Pick<
  PlaygroundPreviewResetResult,
  | 'roomRows'
  | 'recentTaskRows'
  | 'simulatorRecords'
  | 'sources'
  | 'instanceId'
  | 'serverGeneration'
  | 'appliedGeneration'
> {
  return {
    roomRows: 0,
    recentTaskRows: 0,
    simulatorRecords,
    sources: {
      liveRuntime: 0,
      runtimeMemory: 0,
      taskSnapshotRegistry: 0,
      hostSessionRegistry: 0,
      legacyAliasRegistry: 0,
      finalSelector: 0,
    },
    instanceId: 'preview-instance',
    serverGeneration: 2,
    appliedGeneration: 2,
  }
}

describe('Playground preview reset readback', () => {
  it('adopts a generation-zero external-home startup without clearing retained data or opening recovery', () => {
    const dom = new JSDOM(
      '<nav class="pg-navigation-seat"><div data-navigation-group><button data-sidebar-item /></div></nav><section data-playground-recent-tasks><div data-recent-task-row /></section>',
      { url: 'http://127.0.0.1/' },
    )
    const { sessionStorage } = dom.window
    const bootstrap = { version: 1 as const, instanceId: 'new-server', generation: 0 }
    sessionStorage.setItem(
      PLAYGROUND_SIMULATOR_TASK_SNAPSHOT_KEY,
      JSON.stringify({ version: 2, tasks: [{ taskRef: 'retained-task' }] }),
    )
    sessionStorage.setItem(
      PLAYGROUND_PREVIEW_RESET_MARKER_KEY,
      JSON.stringify({
        version: 1,
        nonce: 'old-server:1',
        phase: 'awaiting-readback',
        startedAt: '2026-09-05T00:00:00.000Z',
      }),
    )
    sessionStorage.setItem(
      PLAYGROUND_PREVIEW_RESET_RESULT_KEY,
      JSON.stringify({
        version: 1,
        status: 'failed',
        roomRows: 3,
        recentTaskRows: 6,
        simulatorRecords: 0,
        sources: {
          liveRuntime: 0,
          runtimeMemory: 6,
          taskSnapshotRegistry: 0,
          hostSessionRegistry: 0,
          legacyAliasRegistry: 0,
          finalSelector: 6,
        },
        instanceId: 'old-server',
        serverGeneration: 1,
        appliedGeneration: 1,
        completedAt: '2026-09-05T00:00:00.000Z',
      }),
    )

    expect(reconcilePlaygroundPreviewBootstrapEpoch(sessionStorage, bootstrap)).toBe('bootstrap')
    expect(readPlaygroundPreviewResetApplied(sessionStorage)).toEqual(bootstrap)
    expect(readPlaygroundPreviewResetMarker(sessionStorage)).toBeUndefined()
    expect(sessionStorage.getItem(PLAYGROUND_PREVIEW_RESET_RESULT_KEY)).toBeNull()
    expect(sessionStorage.getItem(PLAYGROUND_SIMULATOR_TASK_SNAPSHOT_KEY)).toContain('retained-task')
    expect(dom.window.document.querySelectorAll('[data-sidebar-item]')).toHaveLength(1)
    expect(dom.window.document.querySelectorAll('[data-recent-task-row]')).toHaveLength(1)
    dom.window.close()
  })

  it('does not downgrade a nonzero explicit reset into bootstrap reconciliation', () => {
    const dom = new JSDOM('', { url: 'http://127.0.0.1/' })
    const { sessionStorage } = dom.window
    sessionStorage.setItem(
      PLAYGROUND_PREVIEW_RESET_MARKER_KEY,
      JSON.stringify({
        version: 1,
        nonce: 'current-server:1',
        phase: 'awaiting-readback',
        startedAt: '2026-09-05T00:00:00.000Z',
      }),
    )
    sessionStorage.setItem(
      PLAYGROUND_PREVIEW_RESET_RESULT_KEY,
      JSON.stringify({
        version: 1,
        status: 'failed',
        roomRows: 1,
        recentTaskRows: 1,
        simulatorRecords: 0,
        sources: {
          liveRuntime: 0,
          runtimeMemory: 1,
          taskSnapshotRegistry: 0,
          hostSessionRegistry: 0,
          legacyAliasRegistry: 0,
          finalSelector: 1,
        },
        instanceId: 'current-server',
        serverGeneration: 1,
        appliedGeneration: 1,
        completedAt: '2026-09-05T00:00:00.000Z',
      }),
    )

    expect(
      reconcilePlaygroundPreviewBootstrapEpoch(sessionStorage, {
        version: 1,
        instanceId: 'current-server',
        generation: 1,
      }),
    ).toBe('unchanged')
    expect(readPlaygroundPreviewResetMarker(sessionStorage)?.phase).toBe('awaiting-readback')
    expect(sessionStorage.getItem(PLAYGROUND_PREVIEW_RESET_RESULT_KEY)).not.toBeNull()
    expect(sessionStorage.getItem(PLAYGROUND_PREVIEW_RESET_APPLIED_KEY)).toBeNull()
    expect(playgroundPreviewResetDisposition({
      ...resetReadback(0),
      roomRows: 1,
      recentTaskRows: 1,
      sources: {
        liveRuntime: 0,
        runtimeMemory: 1,
        taskSnapshotRegistry: 0,
        hostSessionRegistry: 0,
        legacyAliasRegistry: 0,
        finalSelector: 1,
      },
    })).toEqual({ complete: false, confirmationOpen: true })
    dom.window.close()
  })

  it('treats the valid empty task snapshot registry rebuilt after reset as complete', () => {
    const dom = new JSDOM('', { url: 'http://127.0.0.1/' })
    dom.window.sessionStorage.setItem(PLAYGROUND_SIMULATOR_TASK_SNAPSHOT_KEY, JSON.stringify({ version: 2, tasks: [] }))

    const simulatorRecords = countPlaygroundSimulatorSessionRecords(dom.window.sessionStorage)
    expect(simulatorRecords).toBe(0)
    expect(playgroundPreviewResetDisposition(resetReadback(simulatorRecords))).toEqual({
      complete: true,
      confirmationOpen: false,
    })
    dom.window.close()
  })

  it('keeps non-empty, malformed, and unrelated disposable registries fail closed', () => {
    const dom = new JSDOM('', { url: 'http://127.0.0.1/' })
    const { sessionStorage } = dom.window

    sessionStorage.setItem(
      PLAYGROUND_SIMULATOR_TASK_SNAPSHOT_KEY,
      JSON.stringify({ version: 2, tasks: [{ id: 'one' }, { id: 'two' }] }),
    )
    expect(countPlaygroundSimulatorSessionRecords(sessionStorage)).toBe(2)
    expect(playgroundPreviewResetDisposition(resetReadback(2))).toEqual({
      complete: false,
      confirmationOpen: true,
    })

    sessionStorage.setItem(PLAYGROUND_SIMULATOR_TASK_SNAPSHOT_KEY, '{malformed')
    expect(countPlaygroundSimulatorSessionRecords(sessionStorage)).toBe(1)

    sessionStorage.setItem(PLAYGROUND_SIMULATOR_TASK_SNAPSHOT_KEY, JSON.stringify({ version: 1, tasks: [] }))
    expect(countPlaygroundSimulatorSessionRecords(sessionStorage)).toBe(1)

    sessionStorage.setItem(PLAYGROUND_SIMULATOR_TASK_SNAPSHOT_KEY, JSON.stringify({ version: 2, tasks: [] }))
    sessionStorage.setItem('cordisx.playground.simulator/v1:other-registry', JSON.stringify({ version: 2, tasks: [] }))
    expect(countPlaygroundSimulatorSessionRecords(sessionStorage)).toBe(1)
    dom.window.close()
  })
})
