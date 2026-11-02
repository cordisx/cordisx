import type { StartupContextV1, StartupDeclarationV1, StartupObserverV1 } from '@cordisx/protocol/startup/v1'
import type {
  StartupManagedServiceConfigurationV1,
  StartupManagedServiceConfigV1,
  StartupManagedServiceNodeModuleV1,
  StartupManagedServicePrepareV1,
} from '@cordisx/protocol/startup-runtime/v1'

declare const context: StartupContextV1
declare const declaration: StartupDeclarationV1
declare const module: StartupManagedServiceNodeModuleV1
declare const configuration: StartupManagedServiceConfigurationV1

context.startup satisfies StartupObserverV1
module.prepare satisfies StartupManagedServicePrepareV1
if (module.Config) module.Config satisfies StartupManagedServiceConfigV1
configuration.contract satisfies 'cordisx.managed-service-instance-configuration/v1'
declaration.contract satisfies 'cordisx.startup-declaration/v1'
