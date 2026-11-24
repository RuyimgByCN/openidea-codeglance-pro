# CodeGlance Pro for OpenIDEA

A CodeGlance Pro-style editor minimap plugin built for OpenIDEA's `editorPanels` API (`^1.14`, OpenIDEA `v0.1.50+`).

## Features

- **Syntax & semantic code overview**: renders editor lines in **Clean Mode** (crisp token blocks) or fine glyph texture mode with selectable color palette (`syntax`, `monochrome`, `accent`), configurable height (`2px`, `3px`, `4px`), tab-stop alignment, and large-file threshold (`maxLines`).
- **Docked Hover Code Lens**: hovering over the minimap reveals an automatically positioned floating preview of the code around that line, with shared leading indentation trimmed so nested Java/Rust/TS code stays readable inside the minimap pane.
- **Region dividers**: detects `// region <name>`, `//#region <name>`, `# region <name>`, `// MARK: <name>`, `/* region <name> */`, and `<!-- region <name> -->` comments and marks section bands in the minimap.
- **Folding & Soft-Wrap sync**: tracks code folds (`editor.folded()`) and visual wrapped line heights (`editor.wrapped()` / `onLayout`).
- **Markers & navigation**: draws Git diff change bars on the left, error/warning/weak-warning problem stripes on the right, caret & selection highlights, click-to-jump, smooth drag scrolling, and mouse wheel pass-through.
- **Commands & Settings**:
  - `CodeGlance Pro: Toggle Minimap`
  - `CodeGlance Pro: Toggle Clean Mode`
  - `CodeGlance Pro: Toggle Hover Code Lens`
  - **Settings › Plugins › CodeGlance Pro**

## Permissions (Zero High-Risk Grants)

| Capability | Kind | Purpose |
| --- | --- | --- |
| `editor.read` | required (low) | Read focused editor text, syntax highlights, folds, soft-wrap layout, problems, selections, and VCS change markers. |
| `storage` | required (low) | Persist quick-toggle overrides (`hidden`, `cleanMode`, `showHoverLens`) across sessions. |
| `events` | required (low) | Subscribe to `settings-changed` events to keep minimap configuration synchronized in real time. |

No `net:*`, `process:*`, `fs.*`, `project.*`, or `ide.commands` permissions are requested.

## Build & Package

1. Run tests, build the Wasm component, and validate the package:

   ```sh
   node --test tests/layout.test.mjs
   cargo test
   cargo build --release --target wasm32-wasip2
   mkdir -p dist && cp target/wasm32-wasip2/release/codeglance_pro.wasm dist/plugin.wasm
   openidea-plugin check .
   openidea-plugin pack . --key <key> --publisher ruyimg
   ```

2. In OpenIDEA, install from Marketplace or open **Settings › Plugins › ⚙ › Install Plugin from Package File…** and select `ruyimg.codeglance-pro-0.1.0.oiplugin`.
