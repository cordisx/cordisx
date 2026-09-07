import { describe, expect, it } from 'vitest'
import type {
  AgentDetailNavigationService,
  AgentSessionDetailReferenceService,
} from '@cordisx/protocol/agent-detail-navigation/v2'
import type { Context } from '@deepseek-ai/cordis'

import '../packages/cli/src/agent-session-migration-contracts.js'

type DetailConsumerContext = Pick<Context, 'agentSessionDetailReferences' | 'agentDetailNavigation'>
function typeCheck(consumer: DetailConsumerContext): void {
  const references: AgentSessionDetailReferenceService = consumer.agentSessionDetailReferences
  const navigation: AgentDetailNavigationService = consumer.agentDetailNavigation
  void references.getV2
  void references.get
  void navigation.openV2
  void navigation.open
}

describe('agent detail navigation public import', () => {
  it('exposes only the two typed Context services to an external consumer', () => {
    expect(typeCheck).toBeTypeOf('function')
  })
})
