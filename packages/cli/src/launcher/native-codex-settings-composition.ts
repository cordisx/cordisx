import path from 'node:path'
import { ChatExecutionPreferences } from './chat-execution-preferences.js'
import { createCodexChatSettings } from './codex-chat-settings.js'
import { createCodexModelServices } from './codex-model-services.js'
import type { NativeSubmissionCatalogOptions } from './native-submission-composition.js'
import type { NativeSubmissionControlServer } from './native-submission-control-server.js'

export async function openNativeCodexExecution(input: { homeDir: string; profileId: string }) {
  return ChatExecutionPreferences.open({
    file: path.join(input.homeDir, 'apps', 'codex', 'profiles', input.profileId, 'chat-execution.json'),
    configPath: path.join(input.homeDir, 'config.json'),
    appId: 'codex',
    profileId: input.profileId,
  })
}

/** Production CLI/MCP settings use the same profile store and native reader as the Manager. */
export function nativeCodexSettings(input: {
  readonly execution?: ChatExecutionPreferences | undefined
  readonly configPath?: string | undefined
  readonly options: NativeSubmissionCatalogOptions
  readonly control: Pick<NativeSubmissionControlServer, 'nativeRequest'>
}) {
  const guard = input.options.chatSettingsGuard
  return {
    ...(input.execution === undefined ? {} : {
      execution: createCodexChatSettings({
        native: {
          executionPreferences: () => input.execution,
          exists: async sessionId => {
            const result = await input.control.nativeRequest('thread/read', {
              threadId: sessionId,
              includeTurns: false,
            }) as { thread?: { id?: string } }
            return result.thread?.id === sessionId
          },
        },
        ...(guard ? { guard } : {}),
      }),
    }),
    ...(input.configPath === undefined ? {} : {
      modelServices: createCodexModelServices({
        configPath: input.configPath,
        environment: input.options.nativeDiscoveryEnvironment ?? process.env,
        ...(guard ? { guard } : {}),
      }),
    }),
  }
}
