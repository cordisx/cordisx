# Third-party notices

The CordisX CLI depends on packages distributed separately by npm. Their
licenses remain with their respective copyright holders:

| Package                    | Version used by this beta | Registry license |
| -------------------------- | ------------------------- | ---------------- |
| `@deepseek-ai/cordis`      | `4.0.1`                   | MIT              |
| `@deepseek-ai/schemastery` | `3.18.1`                  | MIT              |
| `@shikitor/core`           | `1.0.2`                   | MIT              |
| `es-module-lexer`          | `1.7.0`                   | MIT              |
| `esbuild`                  | `^0.25.9`                 | MIT              |
| `intl-messageformat`       | `11.2.14`                 | BSD-3-Clause     |
| `lightningcss`             | `1.33.0`                  | MPL-2.0          |
| `luna-console`             | `1.3.6`                   | MIT              |
| `luna-data-grid`           | `1.6.5`                   | MIT              |
| `luna-dom-viewer`          | `1.8.4`                   | MIT              |
| `luna-object-viewer`       | `0.3.2`                   | MIT              |
| `reicon`                   | `1.2.1`                   | MIT              |
| `tdesign-react`            | `1.18.2`                  | MIT              |
| `tar`                      | `7.5.22`                  | BlueOak-1.0.0    |
| `ws`                       | `^8.18.3`                 | MIT              |

CordisX bundles only the selected Reicon glyph modules referenced by its
Host-private semantic icon catalog. Reicon credits Solar Icons, designed by
480 Design, under CC BY 4.0 and Zappicon under the Zappicon License as base-icon
sources. Reicon, Zappicon, and Solar Icons remain upstream assets; CordisX does
not represent them as CordisX-owned MIT icon assets, export their raw SVG/icon
dataset, or provide an icon-library redistribution channel. The retained Reicon
MIT terms and upstream credits are at `third_party/reicon-MIT.txt` and
`third_party/reicon-icon-credits.txt`.

The exact dependency graph in `package-lock.json` contains MIT, Apache-2.0,
BSD-3-Clause, BlueOak-1.0.0, ISC, and MPL-2.0 license identifiers for production
dependencies in this beta. This inventory is evidence for release review, not
legal advice.

The plugin DevTools Console pins and locally bundles Luna Console with its
official Luna Object Viewer, Data Grid, and DOM Viewer peers. Their upstream
project is liriliri/luna; all four packages are MIT licensed (copyright
liriliri contributors). CordisX inserts each safe structured `method + args[]`
record independently into Luna Console. The separate Host Inspector contains
metadata only. There is no runtime CDN dependency.
