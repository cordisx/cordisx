import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  playgroundPreviewResetDisposition,
  type PlaygroundPreviewResetResult,
} from '../packages/cli/src/playground/client/preview-reset.js'
import {
  countPlaygroundSimulatorSessionRecords,
  PLAYGROUND_SIMULATOR_TASK_SNAPSHOT_KEY,
} from '../packages/cli/src/playground/client/task-details-navigation.js'

function resetReadback(simulatorRecords: number): Pick<PlaygroundPreviewResetResult,
  'roomRows' | 'recentTaskRows' | 'simulatorRecords' | 'sources' | 'instanceId' | 'serverGeneration' | 'appliedGeneration'> {
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

    sessionStorage.setItem(PLAYGROUND_SIMULATOR_TASK_SNAPSHOT_KEY, JSON.stringify({ version: 2, tasks: [{ id: 'one' }, { id: 'two' }] }))
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
