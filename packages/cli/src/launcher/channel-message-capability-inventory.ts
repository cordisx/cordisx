export const CHANNEL_MESSAGE_CAPABILITY_INVENTORY = Object.freeze([
  {
    capability: 'thread-history-pagination',
    implementation: 'supported',
    reason:
      'CLI/RPC thread-history verifies a same-conversation anchor and reads one bounded topic page; read permission is still required.',
  },
  {
    capability: 'platform-message-search',
    implementation: 'supported',
    reason:
      'CLI/RPC message-search applies exact conversation/time filters and verifies every authoritative message detail before disclosure; read/search permissions remain required.',
  },
  {
    capability: 'historical-resource-refetch',
    implementation: 'supported',
    reason:
      'CLI/RPC resource-refetch/status/read verify ancestry and resource association; explicit resource-read policy and platform scopes remain required. Bounded bytes expose no local paths or platform keys.',
  },
  {
    capability: 'thread-forward',
    implementation: 'supported',
    reason:
      'Independent CLI/RPC thread-forward uses the native Feishu/Lark topic envelope and durable receipts; source read and topic-forward policy/platform permissions remain required.',
  },
  {
    capability: 'generic-card-actions',
    implementation: 'supported',
    reason:
      'Explicit CLI/RPC action-notice publication on a verified owned plain card, with owner/version-bound normalized readback. No task dispatch, ctx facade, arbitrary vendor callbacks or durable event-history claim; live permissions remain required.',
  },
  {
    capability: 'richtext-links-inline-images-code-language',
    implementation: 'supported',
    reason:
      'Outbound v3/runtime v4 and CLI/RPC support native links, scoped prepared images, standalone inline code and enumerated code languages on the SDK path; capability support is not permission and edit remains frozen.',
  },
  {
    capability: 'native-mentions-in-edit',
    implementation: 'unsupported',
    reason: 'Native mention syntax rejected; send verification evidence cannot authorize edits.',
  },
  {
    capability: 'member-directory-read',
    implementation: 'supported',
    reason: 'Existing directory capability; no new membership grant or lookup operation.',
  },
  {
    capability: 'urgent-app',
    implementation: 'unsupported',
    reason: 'Future own-message explicit urgency scope and group policy required.',
  },
  {
    capability: 'urgent-sms-phone',
    implementation: 'unsupported',
    reason: 'Paid contact is disabled; explicit cost authorization and independent scopes required.',
  },
  {
    capability: 'share-chat-user',
    implementation: 'unsupported',
    reason: 'Future bounded authorized identity references only.',
  },
  {
    capability: 'calendar-location-send',
    implementation: 'not-verified',
    reason: 'No verified generic message-send path; separate product API boundary.',
  },
])
