import type { CdpSession } from './cdp-session.js'

/** Independent binding ACKs may arrive out of order; finish every request before rollback. */
export async function installRuntimeBindings(
  session: Pick<CdpSession, 'send'>,
  names: readonly string[],
): Promise<void> {
  const results = await Promise.allSettled(names.map(name => session.send('Runtime.addBinding', { name })))
  const failed = results.find(result => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
}
