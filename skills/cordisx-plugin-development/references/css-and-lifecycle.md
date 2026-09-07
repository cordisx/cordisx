# Plugin CSS and lifecycle

Use CSS only for plugin-owned presentation in a documented React body seat.
Keep selectors under an owned class or use CSS Modules; neither technique
creates a sandbox. Host components, native DOM, navigation, forms, page chrome,
and portal roots retain their Host styling and public semantic parameters.

## Imports and types

For Vite projects, prefer a side-effect import beside its owning component:

```ts
import './details.css'
```

Import it from the lazy page module when the styles are needed only there.
Keep the generated `src/vite-env.d.ts` reference to `vite/client` inside each
plugin compile boundary, including workspace and embedded projects. Do not
borrow the business application's tsconfig or declare `*.css` as a string.
Vite types distinguish ordinary CSS (no default value), `*.module.css` (a class
mapping), and `*.css?inline` (processed CSS text).

```ts
import classes from './details.module.css'
import cssText from './details.css?inline'
```

CSS Modules require a compatible development transform as well as production
Vite support. Check the installed Host: older native and Playground transforms
rewrite all default `.css` imports to `?inline`, including `.module.css`.
Until that Host path supports mappings, use owned plain CSS selectors instead
of relying on a mapping in native development. Do not patch the loader in a
plugin or copy the Host's private default-CSS-text compatibility convention.

`?inline` does not install a stylesheet. Use it only when an explicit owner
needs CSS text, such as a component-rendered `<style>{cssText}</style>` whose
presence must follow mounting. Record that reason and verify HMR, multiple
mounts, remounting and cleanup. The style element's location does not scope its
selectors. Existing inline style props or small static style strings are not
automatically defects; inspect the consumer and intended lifetime before migration.

## Different lifetimes

| Path                                                                 | Loading and update owner                                                                               | Cleanup boundary                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native `cordisx dev` or direct Playground Vite modules, ordinary CSS | Vite injects styles and applies CSS HMR                                                                | Component unmount does not remove a module import. Do not assume a plugin generation replacement or disable prunes Vite styles; verify the installed Host. Native launcher stop has separate Vite-client cleanup. |
| Playground explicitly configured local plugins                       | Host builds an indexed production graph and watches source to rebuild the composition                  | Composition disposal retires renderer resources; this is not direct plugin CSS HMR.                                                                                                                               |
| Installed indexed production graph                                   | `cordisx/vite` retains CSS in `artifact.json`; Host stages initial styles and tracks lazy graph styles | Host retires generation resources. Closing a page is not generation retirement.                                                                                                                                   |
| Component-rendered inline CSS text                                   | Vite processes the text; React owns the rendered style element                                         | Mounted-tree lifetime, provided the owning root is disposed. Top-level manual DOM insertion has no such ownership.                                                                                                |

Use the existing `cordisXPluginViteConfig()` helper and preserve the entire
indexed output graph in the tarball. Do not flatten lazy chunks, copy only the
entry, or add another style loader. Vite preload code and Host resource
tracking may create two stylesheet links for one lazy URL. The existing Host
registry tracks both; two links alone do not prove a leak or duplicate network
transfer. Do not remove either loading step without checking its consumers.

For migration, inspect source imports, development transforms, production
artifact, package exports and actual consumers first. Per-file declaration or
service output beside a runtime graph may be intentional. Build/typecheck and
tarball inspection prove packaging; real native and installed-generation tests
prove their respective runtime behavior. Do not claim one from the other.
