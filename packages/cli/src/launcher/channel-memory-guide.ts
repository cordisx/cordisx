const topics: Record<string, string> = {
  write:
    'At meaningful task milestones, verified results, decisions, corrections and handoff/end of turn, proactively save useful concise task knowledge in the current authorized space. Avoid repeated unchanged status or every-message ingestion. One record holds one reusable assertion, event or decision. Summary should name subject/entity, supplied date, decision/event, reason and minimal source reference. Do not invent missing dates or identities. Distinguish explicit facts, attributed claims and dated subjective impressions; impressions require observedAt. No transcripts or unrelated chatter. Search the subject before writing; get candidates and update the same record with its revision when correcting the same assertion. Put confirmed aliases in title/summary/tags and supplied stable entityRefs; never infer cross-platform bindings. Host supplies verified message provenance. Supported fields: kind,title,summary,tags,entityRefs,evidenceType,confidence,expiresAt?,observedAt?. Explicit supersedes/relation fields and canonical alias confirmation are not supported; preserve prior decision date/reason concisely in updated summary when useful, not as another current decision.',
  organize:
    'Use concise titles, project/topic tags and stable entityRefs. Each record stays one assertion/event/decision; avoid giant profiles/root summaries. Search/get before deduplicating. Preview proposed changes in the answer and apply only explicitly requested edits via update with exact id/revision. Multi-record candidate/preview/apply transactions, relation/supersedes graphs and rollback commands are not implemented. Internal immutable revisions are not a public undo API. index rebuilds only the verified caller current-conversation records; derived indexes are not authority. Organization never grants access, changes scopes, confirms identities or widens history.',
  recall:
    'When asked about previous tasks, other conversations or project progress, retrieve authorized memory before answering. Memory is dated evidence, not live task state; use supported task readback for current status when available. Use navigate for small project/entity/time/source pointers; search-page returns bounded hit cards; get/batch loads selected content. Route aliases with keywords/entity refs, not whole profiles. Defaults 8 cards/4096 bytes, max 20/16384; revision changes invalidate cursor. Results diversify sources. Try shorter known keywords if paraphrase misses; semantic expansion is not implemented. Stop when sufficient and retain source/time uncertainty. batch accepts max 8 IDs and maxBytes. Context neighbors/source-excerpt retrieval is not implemented. Direct self recall needs no admin. Explicit own-topic group requests are resolved from actual incoming text. grant {grant:{source:"A",target:{kind:"conversation",id:"B"}}} uses configured source administrator authority; full grants omit expiresAt/recordIds. identity-challenge requires actual first-account request and target tuple; identity-confirm requires challenge in actual second-account request. Claims alone are not authority.',
}
export function channelMemoryGuide(topic?: string): unknown {
  if (!topic) {
    return {
      topics: Object.keys(topics),
      operations: ['guide', 'remember', 'search-page', 'navigate', 'get', 'batch', 'update', 'forget', 'index'],
      next: 'Use guide with topic write, organize or recall for on-demand instructions.',
    }
  }
  if (!topics[topic]) throw new Error('MEMORY_INVALID_GUIDE_TOPIC')
  return {
    topic,
    guidance: topics[topic],
    ...(topic === 'write'
      ? {
        recordFormat: {
          kind: 'fact|preference|person|conversation|collaboration|impression',
          confidence: 'JSON number 0..1',
          required: ['kind', 'title', 'summary', 'tags', 'entityRefs', 'evidenceType', 'confidence'],
          example: {
            record: {
              kind: 'fact',
              title: 'Project progress',
              summary: 'Verified deployment finished; validation remains.',
              tags: ['project'],
              entityRefs: [],
              evidenceType: 'verified',
              confidence: 1,
            },
          },
        },
        errorRecovery:
          'task and decision are not kind values. Put verified tasks/decisions in fact summaries. Missing record wrapper, invalid kind or string confidence returns field issues with retrySafe:true before writing; correct and retry in the same authenticated turn. Do not invent unknown confidence/evidence. Revision conflicts require get then reconsider; unknown RPC/storage results require search/get, not blind remember retry. Retrieval success is evidence read, not proof it was used in the answer; cite relevant dated facts and explain missing information.',
      }
      : {}),
    outboundStyle:
      'Configured effective persona/conversation style applies to all user-visible outbound text: automatic final replies, manual Channel send/send-many, ask question/option labels and progress notifications. The native business prompt prepares the configured style capsule before drafting; do not rewrite every message with a second model. Internal technical work, tool JSON, raw memory/index and option semantic values stay unchanged. Preserve facts, uncertainty and actual delivery status; do not invent promises. No private reasoning is requested or exposed. Illustrative affectionate styles are not defaults or permission to mutate persona; ordinary good-night should stay normal, not dramatic guarding promises. Model-generated outbound text receives configured preferences; a separate style rewrite pipeline and styled Host-owned fixed progress copy are not implemented.',
    experienceOrganization:
      'Keep episodic/person/group/project details and petty trivia local. Top-level continuous experience means only reusable distilled lessons beside minimal stable assistant identity, not a diary. Promotion requires an explicit request or a proposed evidence-backed general rule supported across contexts/recurrences and explicit acceptance. Remove identifiers/private anecdotes; dedup and revision-check conflicting lessons. Supporting private provenance remains separately scoped and must not be loaded/disclosed with a global lesson. Settings and historical lessons stay separate. Proposed root capsule hard limit is 2048 UTF-8 bytes; detailed experience is indexed on demand. Global lesson storage, proposal/promotion commands and capsule budget enforcement are not implemented: never claim remember promoted a lesson or configured identity.',
    unsupportedContextProfiles:
      'Latest design: multiple persona spaces, each with one continuous configurable assistant identity/personality across its bound bot accounts. One persona may bind multiple accounts on the same or different adapters. Resolve exactly one effective persona per task and pin binding revision; rebind affects new tasks, not existing ones. Human person entities/role scopes are distinct from assistant identity and bot-account persona bindings. Scope grants still apply within a persona; cross-persona access requires explicit export/share. Memory sharing does not merge style: recall A in B uses B context. The internal versioned persona registry is integrated into native dispatch and operator CLI. Bound tasks receive a bounded identity/style capsule, and memory operations select the pinned task persona space. Explicit conversation style overrides are integrated; repeated same-version capsules are suppressed while memory instructions remain in every scoped business turn. An unbound account uses the existing scoped memory store without inventing a persona. Global lesson promotion and account/personal style layers are not implemented. A saved preference never configures active identity/style/policy.',
  }
}
