export const CHANNEL_MESSAGE_CAPABILITY_INVENTORY = Object.freeze([
  {
    capability: 'thread-history-pagination',
    implementation: 'supported',
    reason:
      'CLI/RPC thread-history verifies a same-conversation anchor and reads one bounded topic page; read permission is still required.',
  },
  {
    capability: 'platform-message-search',
    implementation: 'unsupported',
    reason: 'Official body and authorization boundary need separate verification.',
  },
  {
    capability: 'historical-resource-refetch',
    implementation: 'unsupported',
    reason: 'No scoped public operation for historical media resource preparation.',
  },
  {
    capability: 'thread-forward',
    implementation: 'supported',
    reason:
      'Independent CLI/RPC thread-forward uses the native Feishu/Lark topic envelope and durable receipts; source read and topic-forward policy/platform permissions remain required.',
  },
  {
    capability: 'generic-card-actions',
    implementation: 'unsupported',
    reason: 'Only specialized approval/question callbacks exist; card update is not an action lifecycle.',
  },
  {
    capability: 'richtext-links-inline-images-code-language',
    implementation: 'not-verified',
    reason: 'Use exact outbound contract capability; not supplied by message editing.',
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
