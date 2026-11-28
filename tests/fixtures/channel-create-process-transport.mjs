import { appendFile } from 'node:fs/promises'
import path from 'node:path'

/** Exercise the real adapter with a transport that cannot receive or send. */
export function createSyntheticChannel(options) {
  if (
    ![
      ['cli_created_fixture', 'synthetic-create-secret'],
      ['cli_pending_fixture', 'synthetic-pending-secret'],
    ].some(([account, secret]) => account === options.appId && secret === options.appSecret)
  ) {
    throw new Error('Unexpected synthetic Channel credentials')
  }
  const marker = path.join(process.env.CORDISX_HOME, 'synthetic-adapter.log')
  return {
    on: () => () => {},
    connect: async () => await appendFile(marker, `connected:${options.appId}\n`, { mode: 0o600 }),
    disconnect: async () => await appendFile(marker, `disconnected:${options.appId}\n`, { mode: 0o600 }),
    send: async () => {
      throw new Error('Synthetic transport cannot send')
    },
  }
}
