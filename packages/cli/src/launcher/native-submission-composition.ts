import { constants } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
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
import {
  NATIVE_OPERATION_REQUEST_TRANSFORM,
  NATIVE_OPERATION_REQUEST_TRANSFORM_9275,
  NATIVE_OPERATION_REQUEST_TRANSFORM_9647,
} from '../renderer/adapter/native-operation-request-transform.js'
import {
  NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM,
  NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM_BUILD_9275,
  NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM_BUILD_9647,
} from '../renderer/adapter/native-submit-orchestrator-transform.js'

const execFileAsync = promisify(execFile)

const NATIVE_SUBMISSION_TRANSFORMS = Object.freeze([
  Object.freeze({
    appVersion: '26.901.51231',
    buildNumber: '8109',
    transforms: Object.freeze([NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM, NATIVE_OPERATION_REQUEST_TRANSFORM]),
  }),
  Object.freeze({
    appVersion: '26.908.70816',
    buildNumber: '9275',
    transforms: Object.freeze([
      NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM_BUILD_9275,
      NATIVE_OPERATION_REQUEST_TRANSFORM_9275,
    ]),
  }),
  Object.freeze({
    appVersion: '26.911.61220',
    buildNumber: '9647',
    transforms: Object.freeze([
      NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM_BUILD_9647,
      NATIVE_OPERATION_REQUEST_TRANSFORM_9647,
    ]),
  }),
])

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

export function nativeSubmissionTransformsForApp(
  appVersion: string,
  buildNumber: string,
): readonly NativeResourceTransform[] | undefined {
  return NATIVE_SUBMISSION_TRANSFORMS.find(pin => (
    pin.appVersion === appVersion && pin.buildNumber === buildNumber
  ))?.transforms
}

async function nativeSubmissionTransforms(contents: string): Promise<readonly NativeResourceTransform[]> {
  const info = path.join(contents, 'Info.plist')
  const [appVersion, buildNumber] = await Promise.all([
    execFileAsync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', info]),
    execFileAsync('/usr/bin/plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', info]),
  ])
  const identity = {
    appVersion: appVersion.stdout.trim(),
    buildNumber: buildNumber.stdout.trim(),
  }
  const transforms = nativeSubmissionTransformsForApp(identity.appVersion, identity.buildNumber)
  if (transforms === undefined) {
    throw new Error(`Native submission has not audited Codex Desktop ${identity.appVersion} (${identity.buildNumber})`)
  }
  return transforms
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
  const contents = path.dirname(macos)
  const cli = await realpath(path.join(contents, 'Resources', 'codex'))
  await access(cli, constants.X_OK)
  await access(nativeAppServerIntermediaryPath(), constants.X_OK)
  const transforms = await nativeSubmissionTransforms(contents)
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
        transforms,
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
