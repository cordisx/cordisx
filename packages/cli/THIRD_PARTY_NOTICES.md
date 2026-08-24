# Third-party notices

The CordisX CLI depends on packages distributed separately by npm. Their
licenses remain with their respective copyright holders:

| Package | Version used by this beta | Registry license |
| --- | --- | --- |
| `@deepseek-ai/cordis` | `4.0.1` | MIT |
| `@deepseek-ai/schemastery` | `3.18.1` | MIT |
| `@material-symbols/svg-400` | `0.46.0` | Apache-2.0 |
| `esbuild` | `^0.25.9` | MIT |
| `intl-messageformat` | `11.2.14` | BSD-3-Clause |
| `luna-console` | `1.3.6` | MIT |
| `luna-data-grid` | `1.6.5` | MIT |
| `luna-dom-viewer` | `1.8.4` | MIT |
| `luna-object-viewer` | `0.3.2` | MIT |
| `tar` | `7.5.22` | BlueOak-1.0.0 |
| `ws` | `^8.18.3` | MIT |

CordisX copies selected Material Symbols SVG assets into its built output. The
complete Apache License 2.0 text distributed by that package is included at
`third_party/material-symbols-APACHE-2.0.txt`.

The exact dependency graph in `package-lock.json` contains MIT, Apache-2.0,
BSD-3-Clause, BlueOak-1.0.0, and ISC license identifiers for production
dependencies in this beta. This inventory is evidence for release review, not
legal advice.

The plugin DevTools Console pins and locally bundles Luna Console with its
official Luna Object Viewer, Data Grid, and DOM Viewer peers. Their upstream
project is liriliri/luna; all four packages are MIT licensed (copyright
liriliri contributors). CordisX inserts each safe structured `method + args[]`
record independently into Luna Console. The separate Host Inspector contains
metadata only. There is no runtime CDN dependency.

## Evaluated but not distributed

`tdesign-web-components@1.2.10` (MIT) was evaluated for the Host-owned form
system. CordisX does not depend on, copy, bundle, or load that package or its
assets in this release, so it is intentionally absent from the dependency and
license-text inventory above. The package-size, dependency, component-coverage,
style-isolation, and future-adoption gates are recorded in
`.agents/docs/host-form-system.md`.
