# Host typed richtext v3

The launcher exposes `ctx.channel.outboundV3` to a stamped Node plugin context.
Use Protocol runtime v4/outbound v3; older `outbound` and `outboundV2` facades keep
their strict contract/schema fences. Imported types alone are not acquisition.
The shared Channel runtime binds permission, media and delivery records to the
actual caller; it never delegates raw upload credentials to plugins.

The authenticated Feishu/Lark SDK path implements native links, prepared-image
nodes and language-tagged code blocks. Inline code is a standalone block rendered
as a generated CommonMark code span in an exclusive `md` paragraph; it cannot
mix with native mention/link/image nodes. Plain text is not interpreted as
Markdown. The CLI `send` and `send-many` validators select v3 only for successor
structure. Automatic final-response content defaults are unchanged.

Prepared images retain the existing prepare flow and caller/target/generation
scope. Before enqueue, validate all image descriptors and bound their aggregate
bytes to the adapter limit. Before dispatch, recheck descriptors and connection
generation. Before the first upload, resolve and hash-check every image, validate
signatures, preflight the complete rendered post with maximum-size placeholder
keys, and revalidate mentions. Permission or identity failures never fall back.
Explicit unsupported-content text fallback uploads no unused images.

The durable outbox fingerprints all content, handles, descriptors and successor
version. Replay the same operation to inspect its receipt; expiry does not erase
a sent receipt or authorize a new delivery. Uncertain upload/send results are
not automatically retried. Do not issue a fresh operation ID to replay an
uncertain effect. Editing remains on its existing restricted content path and
cannot acquire upload or mention authority from v3 send.

Bounds: 128 blocks, 128 nodes per paragraph, 1024 total nodes, 65536 total text
code points, 16 image-node occurrences, and 196608 UTF-8 bytes for serialized
content, request and rendered post. Links allow absolute HTTP/HTTPS without
userinfo, controls, whitespace or backslashes; encoded controls/backslashes are
also rejected. Links do not trigger fetching. Language metadata accepts the
documented uppercase enumeration, not arbitrary vendor content.

The implementation is verified through runtime/service, CLI/RPC and configured
factory-to-SDK tests. The configured CLI command also exercises its real Unix
socket, shared media preparation, Runtime dispatch, SDK post content and durable
receipt replay. This evidence does not establish deployment or live
platform permission. External v2 adapters do not acquire v3 richtext support by
claiming generic `richtext` in their legacy capability list.

Official Feishu structure reference:
https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json
