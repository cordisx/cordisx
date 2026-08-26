# cordisx

CordisX is an experimental, opt-in local UI plugin host for Codex Desktop.

## Beta quick start

Requires Node.js 22.19 or newer and an installed Codex Desktop application.

```bash
npx cordisx@beta setup
npx cordisx@beta codex --dry-run
npx cordisx@beta codex
```

`setup` creates `~/.cordisx/config.json` with `plugins: []`. The default profile
starts an independent Host window and persistent CordisX-scoped Chromium
profile while sharing the existing account and conversations. Use
`host-isolated` only when a separate Host root is wanted:

```bash
npx cordisx@beta codex work --data host-isolated
```

CordisX starts a separate process and does not modify the installed Codex
application. Plugins are trusted local renderer code; this beta is not a
security sandbox.

## React plugins

Plugins write controlled page bodies with the React singleton supplied by the
Host. Import React and Hooks from `cordisx/react`, and reusable Host components
from `cordisx/ui`. Plugin projects install only `cordisx`; they must not install
or bundle `react`, `react-dom`, or a private React component library. The Host
owns the React root, page chrome, theme, error boundary, and lifecycle cleanup.

## License

The CordisX host, runtime, CLI, manager, launcher, and adapters are licensed
under `AGPL-3.0-or-later`. Commercial use is allowed subject to the AGPL,
including applicable source-availability obligations.

The included CordisX Independent Plugin Exception is an AGPLv3 section 7
additional permission for independent plugins that use only documented,
versioned public plugin interfaces. Those plugins may be commercial and use
licenses chosen by their authors. The Exception does not cover copying,
embedding, modifying, repackaging, or replacing CordisX host code, or using
private interfaces. It is CordisX-specific, is not a standard SPDX exception,
and should receive legal review before stable.

See the [user getting-started guide](https://github.com/cordisx/cordisx/blob/main/.agents/docs/getting-started.md)
and [CLI/distribution contract](https://github.com/cordisx/cordisx/blob/main/.agents/docs/distribution-and-cli.md).
The scoped Host form architecture and the reproducible official TDesign Web
Components subset are documented in the
[Host-owned form system](https://github.com/cordisx/cordisx/blob/main/.agents/docs/host-form-system.md).
