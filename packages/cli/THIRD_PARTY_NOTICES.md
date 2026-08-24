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
| `luna-log` | `0.1.0` | MIT |
| `luna-text-viewer` | `0.2.1` | MIT |
| `tar` | `7.5.22` | BlueOak-1.0.0 |
| `ws` | `^8.18.3` | MIT |

CordisX copies selected Material Symbols SVG assets into its built output. The
complete Apache License 2.0 text distributed by that package is included at
`third_party/material-symbols-APACHE-2.0.txt`.

The exact dependency graph in `package-lock.json` contains MIT, Apache-2.0,
BSD-3-Clause, BlueOak-1.0.0, and ISC license identifiers for production
dependencies in this beta. This inventory is evidence for release review, not
legal advice.

The plugin DevTools Console bundles Luna Log and Luna Text Viewer locally as
its renderer. CordisX retains the structured `method + args[]` capture model
and detail inspection; Luna receives only a safe formatted text projection.
There is no runtime CDN dependency.
