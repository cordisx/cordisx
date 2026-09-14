import type { Context } from '@deepseek-ai/cordis'
import type { PluginController } from './runtime-shared.js'
import { createPluginHttpClients, type PluginHttpClientOptions } from './plugin-http.js'
import { createWalletSpendClient } from './wallet-spend.js'

/** Owner-scoped transport composition; each purpose retains its own client lifetime. */
export function installPluginTransports(
  context: Context,
  controller: PluginController,
  options: PluginHttpClientOptions,
): void {
  const { http, workSettlement } = createPluginHttpClients(options)
  controller.httpClient = http
  controller.unregisterHttp = context.reflect.provide('http', http)
  controller.unregisterWorkSettlement = context.reflect.provide('workSettlement', workSettlement)
  controller.walletSpendClient = createWalletSpendClient(options)
  controller.unregisterWalletSpend = context.reflect.provide('walletSpend', controller.walletSpendClient)
}

export async function disposePluginTransports(controller: PluginController): Promise<void> {
  controller.httpClient?.dispose()
  delete controller.httpClient
  controller.walletSpendClient?.dispose()
  delete controller.walletSpendClient
  await controller.unregisterWalletSpend?.()
  delete controller.unregisterWalletSpend
  await controller.unregisterWorkSettlement?.()
  delete controller.unregisterWorkSettlement
  await controller.unregisterHttp?.()
  delete controller.unregisterHttp
}
