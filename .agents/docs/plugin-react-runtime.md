# Shared React plugin runtime

Status: implemented and verified. Production-bundle,
immutable-package, lifecycle, fresh scaffold, and isolated browser Playground
evidence is recorded below.

## Product decision

CordisX plugins can write page bodies directly in React. The Host provides the
React 19 singleton, JSX runtimes, root lifecycle, theme projection, error
boundary, and a small set of CordisX components. A plugin installs only
`cordisx`; it does not install `react`, `react-dom`, React type packages, or a
component library.

This is a React API, not a framework-neutral compatibility layer. CordisX does
not preserve older private React imports, accept plugin-bundled React copies,
adapt other view frameworks, or provide version negotiation. A plugin bundling `react`, `react-dom`, `tdesign-react`, or
`tdesign-icons-react` into its renderer artifact fails the CordisX build.
Third-party component dependencies may declare React peers; the launcher
resolves those peer imports to the same Host React singleton. Plugin authoring
imports still use `cordisx/react`.

## Authoring surface

Plugin source imports React and JSX types/runtime from `cordisx/react` and Host
components from `cordisx/ui`:

```tsx
import { defineReactPage, useState } from 'cordisx/react'
import { Button, Card, Heading, Stack, Text } from 'cordisx/ui'

const mount = defineReactPage(({ t }) => {
  const [count, setCount] = useState(0)
  return (
    <Card>
      <Heading>{t('page.title')}</Heading>
      <Text>{count}</Text>
      <Button variant="primary" onClick={() => setCount(value => value + 1)}>
        Add
      </Button>
    </Card>
  )
})
```

`defineReactPage` returns the existing page-v3 mount function. The plugin still
registers its localized page and route through `ctx.pages` and `ctx.routes`.
No protocol revision is needed: page-v3 already assigns a trusted local plugin
a bounded body seat while retaining Host ownership of route state and chrome.

The initial `cordisx/ui` set is deliberately small:

- `Button`
- `Card`
- `EmptyState`
- `Heading`
- `Stack`
- `Text`

These are semantic CordisX components, not re-exports of a third-party design
system. Their DOM, accessibility defaults, CSS, theme tokens, and future visual
changes remain Host-owned.

## Runtime and ownership

The immutable package path compiles plugins with automatic JSX and replaces
`cordisx/react`, both JSX runtime subpaths, and `cordisx/ui` with generation-
local virtual modules. Those modules resolve to one frozen Host runtime object;
they do not embed another renderer.

During `cordisx dev`, plugin source joins the Host's Vite ESM graph directly.
The same virtual imports resolve to the Host singleton. Refresh-compatible
component modules use the Host's Vite React plugin and React Fast Refresh.
Plugin entry, manifest, `apply`, and other non-refresh-boundary updates
invalidate the owning plugin module and replace its Cordis generation, which
unmounts the previous roots and contributions. The generated template separates
its named page component from the lifecycle entry so ordinary component edits
form a refresh boundary.

`defineReactPage` creates one Host React root inside the page body container.
It forwards the existing localized page context as component props but never
forwards the raw container, document, or Host controls. Abort, route close,
plugin stop, generation replacement, and runtime disposal all unmount the root.
Runtime disposal also removes Host React styles, theme projection, and the
shared global reference. Render failures remain inside a Host error boundary.

The Host still owns Manager routing, breadcrumbs, page headers, tabs, widths,
scroll ownership, theme, focus, diagnostics, and cleanup. React support does
not authorize a plugin to replace native Codex React trees or Manager chrome.
Schemastery configuration continues to use the Host-owned renderer; React is
for controlled plugin page bodies.

Plugins remain trusted local renderer code, not isolated or sandboxed code.

## Requirement ledger

| Requirement                                                             | Candidate state | Evidence required for the next state                                                                                                                                                                  |
| ----------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin imports React without installing React                           | verified        | generated package installs only `cordisx`, then passes typecheck/build/test/dry-run                                                                                                                   |
| JSX and Hooks execute on the Host React singleton                       | verified        | production renderer composition asserts strict React identity and interactive state update                                                                                                            |
| Plugin can reuse Host components without installing a component library | verified        | production renderer composition renders the `cordisx/ui` classes and interaction                                                                                                                      |
| Plugin-bundled React is rejected                                        | verified        | normal renderer bundle and immutable package artifact tests reject private React                                                                                                                      |
| React roots and effects clean up with page/runtime lifecycle            | verified        | integration test observes effect cleanup and removal of DOM/style/global state                                                                                                                        |
| Generated React plugin is the default scaffold                          | verified        | package contents plus a fresh project using only file-installed `cordisx` pass typecheck, build, manifest test, and `dev:dry-run`                                                                     |
| Development React component is a Fast Refresh boundary                  | verified        | Vite transforms the generated component with Refresh registration, self-acceptance, and boundary validation; focused HMR tests deliver a component update without full reload                         |
| Entry and explicit Manager reload preserve plugin lifecycle ownership   | verified        | Vite invalidates only the selected local-development plugin and the runtime keeps install/enable/disable/uninstall gated by the package lifecycle                                                     |
| Real isolated Playground interaction                                    | verified        | isolated loopback Playground activated the generated plugin, navigated its page-v3 body, clicked `0` to `1`, retained one root/style, logged no error, then removed its tab, port, and temporary Home |
