import {
  adapterReceipts,
  adapterStoreRoot,
  changeAdapterPolicy,
  installAdapterPackage,
  liveAdapterLeases,
  pruneAdapterCache,
  readAdapterState,
} from '../launcher/codex-adapter/store.js'
import { type HomeConfigPathOptions, resolveHomeConfigPath } from '../config/home-config.js'
import path from 'node:path'

export async function runAdapterCommand(
  argv: readonly string[],
  options: HomeConfigPathOptions,
  stdout: (value: string) => void,
): Promise<void> {
  const root = adapterStoreRoot(path.dirname(resolveHomeConfigPath(options)))
  const [operation, ...values] = argv
  if (operation === 'install' && values.length === 1) {
    const receipt = await installAdapterPackage(root, values[0]!, state => stdout(JSON.stringify({ state })))
    stdout(JSON.stringify({ state: 'installed', receipt, activation: 'Use this exact identity, then start normally.' }))
    return
  }
  if (['use', 'pin', 'unpin', 'revoke'].includes(operation ?? '') && (values.length > 0 || operation === 'use')) {
    await changeAdapterPolicy(root, operation as 'use' | 'pin' | 'unpin' | 'revoke', values)
    stdout(
      JSON.stringify({
        state: operation === 'use' ? 'pending-activation' : operation,
        activation:
          'Applies on the next normal launch. Existing windows and intermediary processes keep their loaded modules.',
      }),
    )
    return
  }
  if (operation === 'prune' && values.length === 0) {
    stdout(JSON.stringify({ removed: await pruneAdapterCache(root) }))
    return
  }
  if ((operation === 'status' || operation === undefined) && values.length === 0) {
    const state = await readAdapterState(root)
    stdout(
      JSON.stringify(
        {
          root,
          installed: await adapterReceipts(root),
          preferredForNextLaunch: state.preferred,
          rollback: state.rollback,
          pinned: state.pinned,
          revoked: state.revoked,
          running: await liveAdapterLeases(root),
        },
        null,
        2,
      ),
    )
    return
  }
  throw new Error(
    'Usage: cordisx adapter [status | install <stable|beta|exact-version> | use [identity ...] | pin|unpin|revoke <identity ...> | prune]',
  )
}
