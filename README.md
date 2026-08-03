# MDPlus

MDPlus is a Windows-first desktop Markdown editor built with React, Vite and Tauri. It combines a WYSIWYG editor with a source mode, tabs, automatic saving, Mermaid diagrams, KaTeX math, code highlighting, task lists, search and a document outline.

## Development

Prerequisites:

- Node.js 20 or newer and npm
- Rust stable with the Windows WebView2 runtime
- Tauri prerequisites for the target platform

Install the locked JavaScript dependencies and start the frontend:

```powershell
npm ci
npm run dev
```

For the desktop shell, run `npm run tauri dev`. Set `TAURI_DEV_HOST` in a local `.env` only when the frontend must bind to a specific host; `.env.example` documents the available variable.

## Checks

```powershell
npm run typecheck
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

`npm run check` combines the TypeScript check and frontend unit tests. `npm run tauri:build` creates the platform installer; generated output stays under `dist/` and `src-tauri/target/` and is ignored by Git.

## Project layout

- `src/`: React UI and editor behavior
- `src/lib/`: file operations, persistence, editor plugins and templates
- `src-tauri/`: native file I/O and desktop packaging
- `.github/workflows/ci.yml`: frontend and Rust verification in CI
