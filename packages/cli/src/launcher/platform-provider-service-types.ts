import type {
  PlatformProviderDefinitionV1,
  PlatformProviderFactoryConfigurationV1,
  PlatformProviderRegistrationProjectionV1,
} from '@cordisx/protocol/platform-provider/v1'
import type {
  PlatformProviderDefinitionV2,
  PlatformProviderFactoryConfigurationV2,
  PlatformProviderRegistrationProjectionV2,
} from '@cordisx/protocol/platform-provider/v2'

export type PlatformProviderFactoryConfiguration =
  | PlatformProviderFactoryConfigurationV1
  | PlatformProviderFactoryConfigurationV2
export type PlatformProviderDefinition = PlatformProviderDefinitionV1 | PlatformProviderDefinitionV2
export type PlatformProviderRegistrationProjection =
  | PlatformProviderRegistrationProjectionV1
  | PlatformProviderRegistrationProjectionV2
