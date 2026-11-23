# Channel media and reactions

This candidate extends the existing Channel transport and the `ChannelFeedback`
owner maintained by the mainline TypeScript implementation, rather than a duplicate
JavaScript compatibility controller. It is not yet
a released capability; read the running CLI's help before using it. The packaged
CordisX Skill routes agents to its Channel reference. Incoming turn instructions
provide the exact CLI, profile and `--context`; do not substitute another service.

## Media availability

The candidate Host public media prepare broker supports only `input.kind: bytes`.
Public bytes are limited to the smaller of 131072 bytes and the target's advertised
`maxMediaBytes`. This is separate from the Host CLI's bounded chunk-upload flow.
Source tickets currently fail explicitly with `CHANNEL_MEDIA_UNAVAILABLE`; they are
not treated as paths and the broker never reads a caller-provided filesystem path.
The serialized prepare request is limited to 196608 UTF-8 bytes. This bound,
metadata, declared size and encoded byte length are checked before decoding.
Prepared handles are issued only after complete size, SHA256 and minimal format
signature validation (PNG, JPEG, Ogg Opus, PDF or MP4; binary has no signature).
These checks are not full media decoding or a safety guarantee. Adapter upload
validation remains independent. Handles are memory-only, scoped and expire after
ten minutes; restarting or replacing the owning Host generation revokes them.

Image and rich-post images are downloaded through the authenticated source-message
resource API and composed as native `localImage` inputs. Receiving/downloading an
image is not proof the selected model understands it. Audio, files and video are
accessible attachment descriptions, requiring supported tools and sandbox access;
no transcription, synthesis, video frame extraction or video vision is claimed.
Cards, shares, location, calendars, system and unknown types retain SDK text and
bounded quoted structure when raw content is supplied; stickers have explicit
text fallbacks. Never
fetch arbitrary URLs or reconstruct a local filename from an image key.

The multi-type outbound candidate adds text, image, audio, file, video, richtext
and bounded title/body cards. Discover the running CLI's `help send` and
`help media-prepare`; an older installed Host may not expose the candidate.
Typed content and explicit text fallback are separate from legacy text sends.
No fallback is inferred for upload, permission, validation or platform errors.

Media preparation uses begin, sequential base64 chunks of at most 64 KiB, and
commit. The Host checks declared size, SHA256, type and source/target authority;
it never opens a caller-supplied local path or URL. Prepared handles expire
after ten minutes and are lost on restart. Images support PNG/JPEG up to 10 MB;
audio supports Opus, video MP4, and files PDF or binary up to 30 MB. File/video
names must be safe filenames. These are transport formats, not transcoding or
understanding services. The scoped inbound resend path remains separate.

The public contract belongs to Protocol Channel runtime v2 and outbound v1;
its source draft, Host adoption, formal merge, release, installation and live
platform evidence are separate states. There is no supported
`send --image <path>` or `send --audio <path>` command.

## Reactions

Discover exact arguments with `cordisx channel help reaction`. For an incoming
authorized context supplied by the Host:

```sh
cordisx channel reaction --profile PROFILE --context INCOMING_CONTEXT --input '{"action":"add","emojiType":"OnIt"}'
cordisx channel reaction --profile PROFILE --context INCOMING_CONTEXT --input '{"action":"remove","reactionId":"RETURNED_REACTION_ID"}'
```

Replace placeholders with the exact prompt values. This operation targets only
the source message, not an arbitrary message ID. Preserve returned `reactionId`;
remove only reactions created by this bot. An uncertain API response is not a
receipt and must not be blindly retried. No general public `channel_reaction`
plugin/native tool is advertised; use the configured CLI seam.

Profile-local feedback configuration is read-only to agents. `reaction.emojiType`
selects processing feedback (commonly `OnIt`). `reaction.stoppedEnabled` defaults
to true and `reaction.stoppedEmojiType` to the platform identifier `DONE`, unless
legacy completion configuration selects its earlier behavior. Stopped feedback
means all correlated native turns are confirmed ended, including explicit failure
or interruption; it does not assert the user's whole goal succeeded. Queued,
active, unknown and uncertain handoff states do not qualify. It confirms the new
reaction before removing only SDK-owned Get/OnIt receipts and handles late receipts
without repeating uncertain effects. New inputs alone are eligible; enabling or
restarting does not retroactively change historical messages.

Optional `reaction.completionEmojiType` retains completed-only semantics. If it is
configured without `stoppedEnabled`, default stopped feedback is disabled. Explicit
`stoppedEnabled:true` selects stopped feedback instead, using `stoppedEmojiType`.
All emoji values must be valid platform identifiers, not arbitrary labels such as
lowercase `done`. See [task reception feedback](channel-cli.md#task-reception-feedback)
for independent switches and compatibility behavior.

Human add/remove events on bot messages known to the active adapter are dispatched
as attributed user input with bot message text and available original input.
The model decides whether replying is useful; it does not automatically answer
every reaction. Bot self-events are ignored, and repeated event identity is
deduplicated by the transport. Unknown targets and targets lost on restart are
ignored; this bounded active-generation registry is not complete remote history.

## Contract and evidence boundaries

Existing inbound Protocol v1 can carry attributed reaction context as user text;
there is no fabricated reaction content-block type. Public reaction selection,
add/remove-own capability, reaction receipts/events and durable known-message
ownership need a versioned contribution to `cordisx-protocol` before public plugin
exposure. Launcher-private CLI uses the existing incoming authorization seam.
No installed service, global settings, credentials or account is changed by this
candidate. Synthetic tests are not live platform verification.

Primary transport references are the official SDK 1.73.0 messageReaction
create/delete and normalized reaction event definitions. The source port retains
the installed feedback implementation's at-most-once reminder reservations and
unknown-turn fail-closed behavior. Completion add/remove reservations are durable;
after a restart, lost bot-own reaction IDs fail closed instead of deleting a
human reaction or replaying an uncertain effect. Known-message context is bounded
to this active adapter; ambiguous concurrent original inputs are omitted rather
than falsely attributed. Full workspace build/typecheck and live reaction emoji
acceptance require parent validation; configured syntactically valid emoji names
are still subject to official platform acceptance.

# Forwarded message ingress

The launcher expands `merge_forward` through the configured bot's message-get
client. The returned root must match the incoming message and conversation;
only descendants connected through `upper_message_id` are consumed. Sender
identifiers and timestamps are quoted provenance, never inferred names or
permission grants. Nested forwards are traversed locally without arbitrary
message lookups. Child attachments use the existing resource ingestion path
with the child message ID and the incoming event's resource scope.

Only forward containers can parent descendants. Deleted containers, cycles,
duplicate IDs, disconnected items and explicitly foreign-chat children cannot
introduce content. Sender ID type and sender type are preserved; an arbitrary
sender ID is not relabeled as an open ID. Per-child parse failures do not discard
already accepted siblings. Resource handle identity includes the child message
ID as well as file key, avoiding collisions between repeated keys in one forward.

Limits are 50 child candidates, eight nesting passes, 90 KB of child content,
16 attachments across all children, and a 2.5-second message-read timeout. Missing permissions,
unusable responses and truncation are represented explicitly. This does not
enable arbitrary card actions, cross-conversation history, or media understanding.

## Unified message-content entry (adapter wiring pending)

`feishuMessageContent(message: NormalizedMessage, event: ChannelEventRef,
resources: ChannelInboundResources, options?: FeishuMessageContentOptions)` returns
`Promise<[ChannelContentBlock, ...ChannelContentBlock[]]>`. The options are
`rawContent?: string`, `messageClient?: FeishuForwardClient`, and
`resourceClient?: FeishuMessageResourceClient`. The parent adapter should pass the
incoming event's original `message.content` as `rawContent`, its configured
message-get and message-resource clients, and the original scoped Channel event.
Alternatively SDK `normalize(..., { includeRaw: true })` retains the raw event.
NormalizedMessage alone has no original content JSON unless `includeRaw` is set;
without either source the entry preserves SDK text/resources, not invented fields.
The entry fails closed when normalized message/chat IDs disagree with the event.

SDK 1.73.0 already normalizes text/post/media, interactive card text, shared
chat/user, location, calendar/general_calendar/share_calendar_event, system,
todo and other types. Its merge-forward converter uses `fetchSubMessages`, caps
items at 50, recursively renders local children, returns no aggregated resources,
and treats a missing parent as the root. The Host therefore owns stricter forward
source/nesting validation and attachment ingestion instead of trusting that
converter's rendered text as proof of provenance.

### SDK message-type matrix

The following distinguishes SDK 1.73.0's `im.v1.message.search` response
`meta_data.type` enum (`types/index.d.ts`) from its normalization converter map
(`lib/index.js`). Search/history names are not assumed to be identical to inbound
event names. In particular `share_chat` and `share_user` really are converter
names, but are not the search enum's `share_group_chat` and `share_user_card`.
The Host preserves the original type and uses quoted structure for the latter;
it does not silently rename types or invent an upstream SDK converter.

| Content         | SDK/history type names                                 | SDK normalize 1.73.0                                                   | Unified entry and boundary                                                                                                                                                  |
| --------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cards           | `interactive` (converter), `card` (search enum)        | `interactive` extracts visible card text; `card` uses unknown fallback | Preserve title/body/elements/actions as bounded data; image/file descriptors may use existing authenticated resource ingress; no card actions or hidden template resolution |
| Shared group    | `share_group_chat`; converter `share_chat`             | Only `share_chat` has a group-card converter                           | Preserve supplied group ID/name; no group lookup, join, history read or permission grant                                                                                    |
| Shared contact  | `share_user_card`; converter `share_user`              | Only `share_user` has a contact-card converter                         | Preserve supplied contact ID/name; no identity/profile lookup                                                                                                               |
| Shared document | `cloud_file`                                           | Unknown fallback                                                       | Preserve supplied metadata/reference; do not download `file_key` as an ordinary file or read backing document content                                                       |
| Shared link     | `link`                                                 | Unknown fallback                                                       | Preserve title/URL/metadata; no URL fetch or backing content read                                                                                                           |
| Location        | `location`                                             | Location name and nonzero coordinates                                  | Supplemental structure preserves zero coordinates and supplied address; no geocoding                                                                                        |
| Calendar        | `calendar`, `general_calendar`, `share_calendar_event` | Calendar invite/event/share text and supplied times                    | Preserve additional supplied fields; no calendar API read or RSVP                                                                                                           |
| Task            | `todo`                                                 | Summary title/post body and due time                                   | Preserve supplied task structure; no task lookup or mutation                                                                                                                |
| Poll            | `vote`                                                 | Topic and option labels                                                | Preserve supplied poll structure; no voting or result lookup                                                                                                                |
| Folder          | `folder`                                               | Folder key/name reference                                              | Metadata/reference only; no listing or backing files read                                                                                                                   |
| Sticker/emoji   | `sticker`                                              | Sticker descriptor and placeholder                                     | Preserve supplied description/emoji metadata; descriptor never downloaded; sticker bytes not read or interpreted; inline text emoji remains text                            |
| Unknown         | `unknown`, unrecognized future strings                 | Supplied `text`, otherwise unsupported placeholder                     | Preserve bounded supplied scalar structure; no extra capability or permission                                                                                               |

These enum names are concrete SDK evidence, not proof that every type's raw
payload uses the same schema across event/get/search surfaces. Matrix tests use
synthetic supplied fields and the real installed SDK to assert converter versus
fallback behavior and the Host's retention/no-fetch boundaries. They cover both
share naming families, `card`/`interactive`, `cloud_file`, `link`, `location`, all
three calendar types, `todo`, `vote`, `folder`, `sticker`, `unknown` and a future
type. The search endpoint is inspected as type evidence only; it is not called
by this parser and no search permission is added.

For nonstandard types the supplemental walker retains scalar fields with JSON
paths (including zero coordinates, descriptions, share identifiers, action labels
and URLs as data). It handles both legacy card elements and v2 body elements,
collecting `image_key`/`img_key`/`file_key` descriptors only through the existing
authenticated message-resource API. Cloud-file, folder, sticker and hongbao
tokens are not reinterpreted as downloadable ordinary files. Backing document,
folder, link and sticker-byte limitations are explicit in the resulting text.
The official SDK documentation for `im.v1.messageResource.get` explicitly
excludes sticker resources. SDK sticker descriptors are therefore not attempted
as ordinary image/file downloads. The fallback reports this platform limitation,
not a permission or download failure, and suggests sending an ordinary image.
It does not claim access to the original sticker pixels or a private download API.
No URL fetch, action execution, card update, calendar lookup,
identity lookup, extra SDK capability or new permission is enabled. Placeholder
or template-only cards are described as received; hidden content is not claimed.

Raw JSON is bounded to 90 KB, traversal to 1,000 nodes and 12 levels, text to
90 KB, and descriptors to 16. Resource response acquisition has a 2.5-second
timeout per descriptor; existing stream size/type/timeout validation remains in
`ChannelInboundResources`. Timeout containment does not cancel an underlying SDK
request, but a late response cannot trigger ingestion. These are per-resource
bounds, not a 2.5-second deadline for the entire expanded message.

Primary evidence: installed `@larksuiteoapi/node-sdk` **1.73.0**, declarations
`NormalizedMessage`, `ResourceDescriptor`, `ApiMessageItem`, and implementation
`normalize`, `convertInteractive`, `convertLocation`, `convertMergeForward`,
`buildChildrenMap`, `renderItem`, calendar/share/system converters in `lib/index.js`.
Official references: [message get](https://open.feishu.cn/document/server-docs/im-v1/message/get),
[message resource get](https://open.feishu.cn/document/server-docs/im-v1/message-resource/get),
[SDK source and Channel overview](https://github.com/larksuite/node-sdk).
The official web pages are client-rendered; local SDK declarations/implementation
provide the directly inspected field and normalization evidence, not a claim of
live platform acceptance. Targeted tests cover synthetic SDK normalization,
structure, authenticated resource routing, forward provenance, limits and timeouts.
Adapter wiring and live account verification remain the parent task's work.
