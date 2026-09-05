import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentAdmissionBootstrapRoomReservationService,
  AgentAdmissionBootstrapRoomTarget,
  AgentAdmissionBootstrapRoomTargetReceipt,
  AgentAdmissionBootstrapRoomTargetService,
} from '@cordisx/protocol/agent-admission/v5'
import { describe, expect, it } from 'vitest'
import '../packages/cli/src/agent-session-migration-contracts.js'

type FormalBootstrapRoomConsumer = readonly [
  AgentAdmissionBootstrapRoomTarget,
  AgentAdmissionBootstrapRoomTargetReceipt,
  AgentAdmissionBootstrapRoomTargetService,
  AgentAdmissionBootstrapRoomReservationService,
  Context['agentAdmissionBootstrapRoomTargets'],
  Context['agentAdmissionBootstrapRoomReservations'],
]

const surface = null as unknown as FormalBootstrapRoomConsumer

describe('formal admission v5 current-binding Room public imports', () => {
  it('compiles the plugin-facing Room target and reservation seams', () => {
    expect(surface).toBeNull()
  })

  it('typechecks an external consumer through the packaged cordisx/contracts entrypoint', () => {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
    expect(() => execFileSync(process.execPath, [
      tsc, '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--skipLibCheck',
      'tests/fixtures/agent-admission-v5-external-consumer.ts',
    ], { cwd: root, encoding: 'utf8', stdio: 'pipe' })).not.toThrow()
  })
})
