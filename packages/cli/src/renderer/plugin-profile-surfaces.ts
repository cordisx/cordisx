import type { Context } from '@deepseek-ai/cordis'
import type { PluginController } from './runtime-shared.js'
import { gameUiTheme } from './isolated-game-ui/native-theme.js'
import { createIsolatedGameUiService } from './isolated-game-ui/service.js'
import { createCurrentUserService } from './current-user/service.js'
import { createRestrictedContentService } from './restricted-content-service.js'

export function installPluginProfileSurfaces(
  pluginContext: Context,
  controller: PluginController,
  document: Document,
  agentLoopOptions: { active: () => boolean; ownerKey: string },
): void {
  controller.isolatedGameUi = createIsolatedGameUiService(agentLoopOptions.active, gameUiTheme(document))
  const currentUser = createCurrentUserService(agentLoopOptions.active, agentLoopOptions.ownerKey)
  const releaseCurrentUser = pluginContext.reflect.provide('currentUser', currentUser)
  controller.unregisterCurrentUser = () => {
    currentUser.dispose()
    releaseCurrentUser()
  }
  controller.unregisterIsolatedGameUi = pluginContext.reflect.provide('isolatedGameUi', controller.isolatedGameUi)
  controller.restrictedContent = createRestrictedContentService(agentLoopOptions.active)
  controller.unregisterRestrictedContent = pluginContext.reflect.provide(
    'restrictedContent',
    controller.restrictedContent,
  )
}

export async function disposePluginProfileSurfaces(controller: PluginController): Promise<void> {
  controller.unregisterCurrentUser?.()
  delete controller.unregisterCurrentUser
  controller.isolatedGameUi?.dispose()
  await controller.unregisterIsolatedGameUi?.()
  delete controller.isolatedGameUi
  delete controller.unregisterIsolatedGameUi
  controller.restrictedContent?.dispose()
  await controller.unregisterRestrictedContent?.()
  delete controller.restrictedContent
  delete controller.unregisterRestrictedContent
}
