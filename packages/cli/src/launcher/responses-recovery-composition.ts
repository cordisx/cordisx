import type { HomeConfigProvider } from '../config/home-config.js'
import { configuredEncryptedReplay } from './configured-encrypted-replay.js'
import { startResponsesEncryptedReplay } from './responses-encrypted-replay.js'
import { accountRouting } from '../../assets/launcher/native-responses-recovery.mjs'

export function nativeOpenAiRecoveryEnabled(environment: NodeJS.ProcessEnv): boolean {
  return environment.CORDISX_EXPERIMENTAL_NATIVE_OPENAI_RECOVERY === '1'
}

export function selectNativeRecovery(environment: NodeJS.ProcessEnv, readAccount: () => Promise<unknown>) {
  const enabled = nativeOpenAiRecoveryEnabled(environment)
  const recoveryEnvironment: Record<string, string> = {}
  if (enabled) recoveryEnvironment.CORDISX_EXPERIMENTAL_NATIVE_OPENAI_RECOVERY = '1'
  return {
    environment: recoveryEnvironment,
    readAccount: enabled ? readAccount : undefined,
  }
}

/** One launch-owned recovery transport for both Desktop and headless owners. */
export async function startResponsesRecovery(
  codexHome: string,
  providers: readonly HomeConfigProvider[] = [],
  readAccount?: () => Promise<unknown>,
) {
  const transport = await startResponsesEncryptedReplay()
  try {
    const verifyAccount = readAccount
      ? async (snapshot: string) => JSON.stringify(accountRouting(await readAccount())) === snapshot
      : undefined
    return {
      ...transport,
      prepareConfigured: configuredEncryptedReplay(codexHome, transport.route, providers, verifyAccount),
    }
  } catch (error) {
    await transport.close()
    throw error
  }
}
