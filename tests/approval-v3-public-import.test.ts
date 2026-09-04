import type {
  ApprovalRequestResolver,
  ApprovalRequestResolverClosed,
  ApprovalRequestResolverHandle,
  ApprovalRequestResolverRegisterResult,
  ApprovalRequestRoutingQuestion,
  ApprovalRequestRoutingRegistration,
  ApprovalRequestRoutingResult,
  ApprovalService,
} from '@cordisx/protocol/approval/v3'
import { describe, expect, it } from 'vitest'
import type { CordisXApprovalService } from '../packages/cli/src/renderer/agent-session-runtime.js'

type FormalApprovalRoutingConsumer = readonly [
  ApprovalService,
  ApprovalRequestResolver,
  ApprovalRequestResolverClosed,
  ApprovalRequestResolverHandle,
  ApprovalRequestResolverRegisterResult,
  ApprovalRequestRoutingQuestion,
  ApprovalRequestRoutingRegistration,
  ApprovalRequestRoutingResult,
  CordisXApprovalService,
]

const surface = null as unknown as FormalApprovalRoutingConsumer

describe('formal approval v3 public imports', () => {
  it('compiles the Host resolver registration and routing lifecycle surface', () => {
    expect(surface).toBeNull()
  })
})
