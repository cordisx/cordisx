# Third-party notices

The CordisX CLI depends on packages distributed separately by npm. Their
licenses remain with their respective copyright holders:

| Package | Version used by this beta | Registry license |
| --- | --- | --- |
| `@deepseek-ai/cordis` | `4.0.1` | MIT |
| `@material-symbols/svg-400` | `0.46.0` | Apache-2.0 |
| `esbuild` | `^0.25.9` | MIT |
| `intl-messageformat` | `11.2.14` | BSD-3-Clause |
| `ws` | `^8.18.3` | MIT |

CordisX copies selected Material Symbols SVG assets into its built output. The
complete Apache License 2.0 text distributed by that package is included at
`third_party/material-symbols-APACHE-2.0.txt`.

The exact dependency graph in `package-lock.json` contains only MIT,
Apache-2.0, and BSD-3-Clause license identifiers for production dependencies in
this beta. This inventory is evidence for release review, not legal advice.
