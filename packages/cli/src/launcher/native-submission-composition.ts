import { constants } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ManagedServiceNodeActivation } from './managed-service-node-host.js'
import { nativeModelProviderCatalog } from './native-model-provider-catalog.js'
import { createNativeProviderCredentialBroker } from './native-provider-credential-broker.js'
import { nativeSubmissionCredentialBroker } from './native-submission-credentials.js'
import { createNativeSubmissionController, type NativeSubmissionController } from './native-submission-controller.js'
import {
  createNativeSubmissionCdpAuthority,
  type NativeSubmissionCdpAuthority,
} from './native-submission-cdp-channel.js'
import { startNativeSubmissionControlServer } from './native-submission-control-server.js'
import type { NativeResourceTransform } from './native-predispatch-interception.js'
import { NATIVE_OPERATION_REQUEST_TRANSFORM } from '../renderer/adapter/native-operation-request-transform.js'
import { NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM } from '../renderer/adapter/native-submit-orchestrator-transform.js'

export interface NativeSubmissionInstallation {
  readonly authority: NativeSubmissionCdpAuthority
  readonly transforms: readonly NativeResourceTransform[]
}
export interface NativeSubmissionComposition {
  readonly installation: NativeSubmissionInstallation
  readonly environment: Readonly<Record<string, string>>
  close(): Promise<void>
}
export function nativeAppServerIntermediaryPath(): string {
  return fileURLToPath(new URL('../../assets/launcher/native-app-server-intermediary.mjs', import.meta.url))
}

export async function createNativeSubmissionComposition(
  activation: Pick<ManagedServiceNodeActivation, 'nativeProviderIds' | 'prepareNativeConnection'>,
  desktopExecutable: string,
): Promise<NativeSubmissionComposition> {
  if (process.platform !== 'darwin') throw new Error('Native managed routing requires the audited macOS app')
  const executable = await realpath(desktopExecutable)
  const macos = path.dirname(executable)
  if (path.basename(macos) !== 'MacOS' || path.basename(path.dirname(macos)) !== 'Contents') {
    throw new Error('Native routing requires an app-bundle executable')
  }
  const cli = await realpath(path.join(path.dirname(macos), 'Resources', 'codex'))
  await access(cli, constants.X_OK)
  await access(nativeAppServerIntermediaryPath(), constants.X_OK)
  const control = await startNativeSubmissionControlServer()
  const credentials = createNativeProviderCredentialBroker({ resolve: id => activation.prepareNativeConnection(id) })
  let controller: NativeSubmissionController | undefined
  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> =>
    closePromise ??= (async () => {
      try {
        await controller?.dispose()
      } finally {
        try {
          await credentials.close()
        } finally {
          await control.close()
        }
      }
    })()
  try {
    const cdp = createNativeSubmissionCdpAuthority({
      catalog: nativeModelProviderCatalog(activation),
      isThreadIdle: id => control.isThreadIdle(id),
    })
    controller = createNativeSubmissionController({
      selection: cdp.selection,
      runtime: cdp.runtime,
      existingThread: control.existingThread,
      credentials: nativeSubmissionCredentialBroker({
        credentials,
        resolveEndpoint: id => activation.prepareNativeConnection(id),
      }),
    })
    control.bindController(controller)
    cdp.bindController(controller)
    return {
      installation: {
        authority: cdp,
        transforms: [NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM, NATIVE_OPERATION_REQUEST_TRANSFORM],
      },
      environment: {
        CODEX_CLI_PATH: nativeAppServerIntermediaryPath(),
        CORDISX_NATIVE_CONTROL_SOCKET: control.socketPath,
        CORDISX_NATIVE_CONTROL_NONCE: control.nonce,
        CORDISX_NATIVE_REAL_CODEX_PATH: cli,
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
