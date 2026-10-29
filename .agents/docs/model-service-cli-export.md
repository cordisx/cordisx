# Export model services from the CLI

Status: implemented in source; use `cordisx model export --help` to confirm that
an installed release includes this command. This guide does not establish a
release or installation.

The CLI uses the same bounded `cordisx-models-v1/v2/v3` portable text as the
Manager's model-service Export and Import actions. It exports selected service
configuration and exact model membership, not an account backup or database dump.

## Choose a profile, service and models

List an existing profile's current services and exact model IDs:

```sh
cordisx model export --list --profile work
```

The JSON contains `bindingRef`, `providerId`, `title`, `exportable` and `models`.
Use the binding reference to avoid ambiguous provider IDs. Export a whole service,
or repeat `--model` to choose exact members of one service:

```sh
cordisx model export --profile work --service codex-config:gateway --output ./models.txt
cordisx model export --profile work --service codex-config:gateway --model exact-model-id --output ./one-model.txt
```

Repeat `--service` to export several complete services. `--model` requires exactly
one service. Omitting `--profile` selects the configured Codex default profile;
unknown profiles fail and are never created by export.

With an active compatible CordisX runtime, export its complete current catalog:

```sh
cordisx model export --profile work --all --output ./models.txt
```

`--all` refuses the entire operation if any service is nonportable. There is no
partial-success output. Use `--list` and select individual exportable services
when the catalog also contains plugin-managed connections. Aiden, TraeX and other
managed login connections require installing the relevant plugin and logging in
on the target machine; their opaque tokens and local runtime endpoints cannot
be migrated as portable service configuration.

## Values and file output

Values are omitted by default. The export retains variable names so they can be
completed on the target machine. Explicitly include saved user environment values:

```sh
cordisx model export --service codex-config:gateway --include-values --output ./models-private.txt
```

This text is compressed, **not encrypted**. `--include-values` only includes
enabled user variables saved in CordisX Home configuration and referenced by the
selected services. It does not resolve process environment variables, read account
credential files, execute credential commands/generators, or export inline bearer
tokens, login sessions, secret headers or managed tokens. Inline credentials
become empty target variable placeholders. The existing portable contract also
supports saved variable descriptions and generator scripts; review scripts before
sharing the file or running a generator on the target.

Files are atomically published with mode `0600`. The parent directory must exist.
Existing files are refused unless `--force` explicitly requests replacement of a
regular file. Symlinks and directories are refused.

Omit `--output`, or specify `--output -`, to write only portable text to stdout:

```sh
cordisx model export --service codex-config:gateway --output - | pbcopy
```

Operation and import instructions go to stderr. Prefer `--output PATH` to shell
redirection when saving values, since shell redirection controls its own file
permissions and overwrite behavior. Rejected, unsupported, oversized or empty
selections exit nonzero without publishing a partial export.

## Active and offline availability

An active matching profile uses its authenticated management RPC and actual
catalog authority. A rejected or unavailable live operation fails; it does not
silently fall back to a stale inactive snapshot. A runtime without this command's
catalog support needs a compatible installed release.

Without an active matching runtime, `--list` reports `complete: false` and covers
only the selected profile's local Codex configuration/catalog files. Explicit
`--service codex-config:ID` selections can be exported offline. Managed services,
plugin connections and live discovery are unavailable in this path, so `--all`
is refused. Offline export never starts Codex, app-server, discovery or login.
It uses `CODEX_HOME` (or the ordinary `.codex` directory) for shared profiles and
the profile's existing `codex-home` directory for host-isolated profiles.
Missing or invalid catalog sources fail. No account credential file is needed.

The portable format limits a bundle to 24 services and 10,000 models per service,
with additional decoded/encoded byte limits. If a large catalog is rejected,
select fewer services or exact models and export separate files. The CLI does
not truncate a catalog to fit a successful response.

## Import on the target machine

1. Copy the complete file/text privately to the target machine. For example, on
   macOS, `pbcopy < ./models.txt` copies a saved export to the clipboard.
2. Open the target CordisX Manager, go to **Model services**, select **Import**,
   and paste the complete portable text.
3. Review service/model selection and fill in the missing environment variables
   listed by the CLI and Import dialog. Confirm Import. There is no CLI import
   command.
4. Check that the expected service titles and exact model IDs appear in the
   Manager's model list. Confirm the imported variables are enabled and available
   before using a service. Follow any restart requirement shown for environment
   changes. Install and log in to nonportable provider plugins separately.
