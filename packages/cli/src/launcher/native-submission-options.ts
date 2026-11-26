import type { HomeConfigProvider } from '../config/home-config.js'
import type { HomeConfigProviderBinding } from '../config/home-config-model-catalogs.js'
import type { ModelSelectorIconOverrides } from '../model-selector-branding.js'
import type { CodexChatSettingsGuard } from './codex-chat-settings.js'
import type { ExistingTerminalProviderSource } from './existing-terminal-provider-rpc.js'
import type { ManagedCatalogComposition } from './model-catalog/managed-catalog-composition.js'

export interface NativeSubmissionCatalogOptions {
  readonly chatSettingsGuard?: CodexChatSettingsGuard
  readonly logicalHistory?: (params: unknown) => Promise<unknown>
  readonly logicalOwner?: import('./profile-logical-conversation-owner.js').ProfileLogicalConversationOwner
  readonly contextObserver?: import('./native-context-observer.js').NativeContextObserver
  readonly channel?: (operation: string, input: unknown, metadata?: unknown) => Promise<unknown>
  readonly channelName?: (event: import('@cordisx/channel-runtime').ChannelEventRef) => Promise<string | undefined>
  readonly channelSectionName?: () => string | undefined
  readonly remoteTerminalProvider?: ExistingTerminalProviderSource
  readonly onStage?: (stage: NativeSubmissionCompletionStage) => void
  readonly defaultProviderId?: string
  readonly defaultModelId?: string
  readonly launchSelection?: { providerId: string; model?: string }
  readonly configModelCatalogs?: Readonly<Record<string, string>>
  readonly dynamicModelCatalog?: boolean
  readonly nativeModelDiscovery?: boolean
  readonly selectorIcons?: ModelSelectorIconOverrides
  readonly managedCatalog?: Omit<Parameters<typeof ManagedCatalogComposition.open>[0], 'responsesAvailable'>
  readonly nativeDiscoveryEnvironment?: Readonly<Record<string, string | undefined>>
  readonly providerBindings?: readonly HomeConfigProviderBinding[]
  /** `model-service` declarations, merged into the catalog read from `config.toml`. */
  readonly declaredProviders?: readonly HomeConfigProvider[]
}

export type NativeSubmissionCompletionStage =
  | 'native-submission-completion-start'
  | 'native-submission-resource-analysis-ready'
  | 'native-submission-managed-catalog-ready'
  | 'native-submission-native-catalog-ready'
  | 'native-submission-controller-bound'
