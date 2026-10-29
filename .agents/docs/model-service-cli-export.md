# Export model services from the CLI

Status: implemented in source; check `cordisx model export --help` to confirm the
installed release supports these commands. This guide does not establish a release
or installation.

The CLI uses the same bounded `cordisx-models-v1/v2/v3` portable text as Manager
Export/Import. It exports selected service configuration and exact model membership,
not account login state or a database backup.

## Select services and models

List an existing profile's services and exact model IDs:

```sh
cordisx model export --list --profile work
```

The JSON includes `bindingRef`, `providerId`, `title`, `exportable` and `models`.
Use a binding reference to avoid ambiguous provider IDs. Export one service or
select exact models of one service:

```sh
cordisx model export --profile work --service codex-config:gateway --output ./models.txt
cordisx model export --profile work --service codex-config:gateway --model exact-model-id --output ./one-model.txt
```

Repeat `--service` for several complete services; repeat `--model` for models of
exactly one service. Omit `--profile` for the configured Codex default. Unknown
profiles fail and are never created by export.

With an active compatible runtime, `--all` selects the complete current catalog:

```sh
cordisx model export --profile work --all --output ./models.txt
```

The entire operation is refused if any service is nonportable; there is no partial
success. Select exportable services individually when necessary. Aiden/TraeX and
other managed login connections need their plugin installed and login performed on
the target. Their opaque tokens and local runtime endpoints cannot be transferred.

## Choose variable values before export

If selected services depend on variables and neither value flag was specified,
a terminal with both stdin and stdout connected to a TTY shows the variable names
and asks **before generating portable text or writing any file**:

```text
Variable dependencies: TEST_KEY
A) Include saved, enabled, referenced user values in UNENCRYPTED portable text;
   unavailable values still need completing on the target.
B) Omit values; complete them on the target before using dependent services.
Choose A or B (Q to cancel):
```

A includes eligible saved values. B omits values and retains names for target
completion. The selection produces one final export at the requested destination.
Q, EOF and invalid input cancel without producing an export. Services with no
variable dependencies do not trigger a question.

An explicit value flag records a decision and skips the question, even in a TTY:

```sh
cordisx model export --profile work --service codex-config:gateway --include-values --output ./models-private.txt
cordisx model export --profile work --service codex-config:gateway --exclude-values --output ./models.txt
```

The flags are mutually exclusive. B and `--exclude-values` require completing
missing values on the target before using dependent services. A and
`--include-values` include **only enabled user variables saved in CordisX Home
configuration and referenced by the selected services**. Text is compressed,
**not encrypted**. No process environment resolution, account credential-file
reads, credential-command/generator execution, login sessions, inline/managed
tokens or secret headers are included. Inline credentials become empty target
variable placeholders. The portable contract can retain saved descriptions and
generator scripts; review scripts before sharing or running them on the target.

Even after A or `--include-values`, disabled/unavailable values and inline-token
placeholders can still be missing. Stderr lists those names and explains that
dependent services cannot be used until they are completed on the target. An
explicit value choice does not guarantee a ready-to-use service.

## Noninteractive calls and stdout

If either stdin or stdout is not a TTY, variable-dependent export without a value
flag exits **2**, writes a `status: "choice-required"` JSON record on stderr, and
produces no portable text or file. The record includes variable names, A/B flag
choices, profile and selection; it contains no values. Choose before invoking the
final export with `--include-values` or `--exclude-values`. Tools must not wait for
terminal input or infer consent from lack of a reply.

Both explicit flags support pipes. For example, after choosing B:

```sh
cordisx model export --service codex-config:gateway --exclude-values --output - | pbcopy
```

Omit `--output`, or use `--output -`, for only final portable text on stdout.
Questions, choice-required records, operation status and Import guidance go to
stderr. A no-variable selection exports without asking in either mode.

Files are atomically published with mode `0600`; the parent directory must exist.
Existing files require explicit `--force` to replace a regular file. Symlinks and
directories are refused. Prefer `--output PATH` to shell redirection for saving
values, since the shell controls its own file permissions and overwrite behavior.
Rejected, cancelled, unsupported or oversized operations do not publish partial
exports. An unconfirmed choice never writes a value-free intermediate file.

## Active and offline availability

An active matching profile uses authenticated management RPC and the actual
catalog authority. A live rejection/failure does not fall back to a stale inactive
snapshot. A runtime without compatible catalog support needs a matching release.

Without an active matching runtime, `--list` reports `complete: false`, covering
only selected-profile local Codex configuration/catalog files. Explicit
`--service codex-config:ID` selections work offline; managed/plugin services and
live discovery are unavailable, and `--all` is refused. The same variable-choice
rules apply. No Codex, app-server, discovery or login process is started. Shared
profiles use `CODEX_HOME` or ordinary `.codex`; host-isolated profiles use their
existing `codex-home`. Missing/invalid catalog sources fail. No account credential
file is needed.

Portable bounds are 24 services, 10,000 models per service and additional
encoded/decoded byte limits. If too large, select fewer services or exact models
and export separate files. The CLI does not truncate a successful response.

## Import on the target machine

1. Copy the complete final text/file privately to the target. On macOS,
   `pbcopy < ./models.txt` copies a saved export.
2. Open target **CordisX Manager > Model services > Import** and paste the text.
3. Review the selection, fill the missing variables named by stderr/Import, and
   confirm. There is no CLI import command.
4. Verify expected service titles and exact model IDs in the model list. Confirm
   required variables are enabled/available, follow any displayed restart requirement,
   and install/login to nonportable provider plugins separately.

## AI operation

The shipped `cordisx` Skill routes here. Check installed help first. For AI/tool
operation, use a non-TTY command channel; do not allocate a pseudo-terminal to wait
for a console answer.

- Use read-only `--list` to choose IDs. A call for the selection without a value flag
  returns structured `choice-required` variable names before final generation or
  file publication. This is preparation, not an exported artifact. Use that record
  or a formal export-preparation surface to identify dependencies; never inspect
  credential files, tokens, databases or shell values to fill them.
- Explain the variable names and A/B choices to the user: A includes only saved,
  enabled, referenced values in unencrypted text; B omits values and needs target
  completion. Ask A or B before a final variable-dependent export. Do not add
  `--include-values` without an explicit choice. Honor an already explicit choice
  in the current session without asking again: A maps to `--include-values`, B to
  `--exclude-values`. Neither choice grants unrelated permissions or bypasses native
  approval controls.
- Run the same profile/service/model selection and intended output with the chosen
  flag. Do not create an intermediate value-free file or ask for a second export.
  If the preparation's variable dependencies change before an interactive choice is
  applied, the operation fails and requires reviewing the current selection again.
- Inspect final stderr even after A. List residual missing variable names and target
  completion steps; do not claim the service is ready to use. Aiden/TraeX login state
  is not included: the target needs the provider plugin and login.

Example after preparation reports `TEST_KEY`:

> AI: This export needs `TEST_KEY`. Choose A to include its saved, enabled value in
> unencrypted text, or B to omit it and fill it on the target before use.
>
> User: B, leave the value out.

Perform the final export once, without another confirmation:

```sh
cordisx model export --profile work --service codex-config:gateway --model exact-model-id --exclude-values --output ./models.txt
```

If the user instead chooses A, use `--include-values` for that same selection and
destination. If `TEST_KEY` is still missing, tell the user to fill it in target
Manager Import; do not fetch a substitute from login state or credential files.
