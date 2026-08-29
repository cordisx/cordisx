/**
 * Host-private identity for the production conversation presentation. Plugins
 * receive an ordinary page mount, while the Host keeps presentation authority
 * without adding a forgeable public page-metadata flag.
 */
const conversationMounts = new WeakSet<object>()

export function markAgentConversationPageMount<Mount extends object>(mount: Mount): Mount {
  conversationMounts.add(mount)
  return mount
}

export function isAgentConversationPageMount(mount: object): boolean {
  return conversationMounts.has(mount)
}
