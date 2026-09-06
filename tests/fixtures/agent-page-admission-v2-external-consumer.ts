import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentPageComposerCommandContext,
  AgentPageComposerCommandResult,
} from '@cordisx/protocol/agent-page-admission/v2'
import type { CordisXCommandContext, CordisXReactPageProps } from 'cordisx/contracts'
import 'cordisx/contracts'

const isPageComposerContext = (
  value: CordisXCommandContext['hostContext'],
): value is AgentPageComposerCommandContext =>
  value !== undefined
  && 'contract' in value
  && value.contract === 'cordisx.agent-page-composer-command-context/v2'

/** External page code receives a Host-bound adapter; it never mints an origin or binding. */
export async function submitFromMountedPage(
  page: CordisXReactPageProps,
  submitPayload: string,
): Promise<AgentPageComposerCommandResult> {
  if (page.pageComposer === undefined) return { status: 'unavailable', code: 'unsupported' }
  return await page.pageComposer.execute({
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-composer-command-request.v1.schema.json',
    contract: 'cordisx.agent-page-composer-command-request/v1',
    schemaVersion: 1,
    command: { id: 'room-submit' },
    submitPayload,
  })
}

/** A fresh page handler may navigate only through the opaque Host-issued permit. */
export async function handlePageComposerCommand(ctx: CordisXCommandContext, services: Context): Promise<void> {
  if (!isPageComposerContext(ctx.hostContext)) throw new Error('page composer context is unavailable')
  const navigation = ctx.hostContext.freshRoomNavigation
  if (navigation === undefined) return
  await services.agentPageFreshRoomNavigation.navigate({
    navigation,
    route: {
      outlet: 'main',
      routeDefinitionId: 'room',
      param: 'roomId',
      roomId: 'room-created-by-handler',
    },
  })
}
