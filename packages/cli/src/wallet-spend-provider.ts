/** Node-only provider entrypoint. Never register this authority in the renderer. */
export { listenWalletSpendProvider } from './launcher/wallet-spend-ipc-server.js'
export type { WalletSpendProviderSessionV1, WalletSpendWalletV1 } from './launcher/wallet-spend-ipc-types.js'
