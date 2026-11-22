# Channel media and reactions

This candidate extends the existing Channel transport and the `ChannelFeedback`
owner maintained by the mainline TypeScript implementation, rather than a duplicate
JavaScript compatibility controller. It is not yet
a released capability; read the running CLI's help before using it. The packaged
CordisX Skill routes agents to its Channel reference. Incoming turn instructions
provide the exact CLI, profile and `--context`; do not substitute another service.

## Media availability

Image and rich-post images are downloaded through the authenticated source-message
resource API and composed as native `localImage` inputs. Receiving/downloading an
image is not proof the selected model understands it. Audio, files and video are
accessible attachment descriptions, requiring supported tools and sandbox access;
no transcription, synthesis, video frame extraction or video vision is claimed.
Unsupported cards/location/system/stickers have explicit text fallbacks. Never
fetch arbitrary URLs or reconstruct a local filename from an image key.

Public outbound image/audio CLI and plugin calls remain unavailable pending a
versioned Protocol media descriptor and caller/source-scoped handle-resolution
contract. The launcher-private scoped resend path is implemented and tested;
there is no supported `send --image <path>` or `send --audio <path>` command.

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
selects processing feedback (commonly `OnIt`). Optional
`reaction.completionEmojiType` must be a valid platform emoji identifier; do not
assume the literal string `done` or silently invent a default. Completion replaces
the known processing reaction only after all correlated jobs really complete.
Progress, reminders, failures, cancellations and unknown native outcomes are not
successful completion. No completion mapping means no completion reaction.

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
