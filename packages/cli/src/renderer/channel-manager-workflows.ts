import type { ChannelManagerServiceInput } from './channel-manager.js'
import type { ChannelManagerState } from './channel-manager-state.js'
import { ChannelExecutionWorkflow } from './channel-execution-workflow.js'
import { ChannelPolicyWorkflow } from './channel-policy-workflow.js'
import { ChannelTaskSettingsWorkflow } from './channel-task-settings-workflow.js'

/** Compose Host settings clients once; all inherit the owning Channel generation lifetime. */
export function initializeChannelManagerWorkflows(
  state: Pick<
    ChannelManagerState,
    'tasks' | 'execution' | 'creationExecution' | 'policy' | 'lifetime' | 'disposed' | 'isCurrent'
  >,
  input: Pick<ChannelManagerServiceInput, 'document' | 'actions' | 'profileId' | 'hostGeneration'>,
) {
  if (!input.document || !input.actions) return
  const common = {
    document: input.document,
    profileId: input.profileId ?? 'default',
    hostGeneration: input.hostGeneration ?? 'host-unavailable',
    lifetime: state.lifetime.signal,
    live: () => !state.disposed && state.isCurrent(),
    run: (action, request) => input.actions!.run(action, request),
  } satisfies ConstructorParameters<typeof ChannelExecutionWorkflow>[0]
  state.tasks = new ChannelTaskSettingsWorkflow(common)
  state.execution = new ChannelExecutionWorkflow(common)
  state.creationExecution = new ChannelExecutionWorkflow({ ...common, defaultsScope: 'channel' })
  state.policy = new ChannelPolicyWorkflow({ ...common, signal: common.lifetime, isCurrent: common.live })
}
