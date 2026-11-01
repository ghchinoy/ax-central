# Documentation, Diagrams & Visual Assets Directive

This directive governs `README.md`, `CHANGELOG.md`, `docs/**` (Diátaxis), Luminous Graphviz diagrams (`docs/diagrams/*.dot`), and automated WebP screenshots (`docs/screenshots/*.webp`).

## 1. Diátaxis Documentation Architecture (`docs/`)
Keep the four Diátaxis quadrants strictly separated by user intent:
- **Tutorials (`docs/tutorials/`)** — *Learning-oriented*: Guided, reproducible hands-on lessons (e.g., booting the 3-second `ate-local` stack and running a `debian:12` task from start to finish).
- **How-To Guides (`docs/how-to/`)** — *Task-oriented*: Step-by-step recipes for specific goals (e.g., bootstrapping prerequisites with `hack/doctor.sh --install`, managing `ate-local` vs. `kind`, driving AX Central via WebMCP).
- **Reference (`docs/reference/`)** — *Information-oriented*: Exhaustive, factual tables for all 16 WebMCP tools, `Makefile` targets, `hack/doctor.sh --json` output schema, and keyboard shortcuts.
- **Explanation (`docs/explanation/`)** — *Understanding-oriented*: Architectural rationale covering the Wails v2 Go bridge (`shell.go`), `docker-shim.sh` digest preservation, Lit 3 Luminous tokens, `TerminalBackend`, and the `ate-local` $\leftrightarrow$ Agent Substrate glidepath.

## 2. Repository Authoring Skills (`~/projects/agent-skills/plugins/repo-authoring`)
- **`make-readme` (`skills/make-readme/SKILL.md`)**:
  - Score `README.md` against `references/scoring-rubric.md` (Mark Allen weighted rubric, target $\ge 36/40$).
  - Keep Install/Quickstart (`make doctor`, `make bootstrap`, `make dev`) near the top and ensure the Table of Contents matches `##` headings.
- **`changelog-manager` (`skills/changelog-manager/SKILL.md`)**:
  - Adhere to Keep a Changelog v1.1.0 (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`) and Common Changelog (italic `_Initial release._` notice, bold impact prefixes, synthesized human-readable entries with `[ax-central-xxx]` bead references, and bottom comparison links).
- **`technical-post-editorial` (`skills/technical-post-editorial/SKILL.md`)**:
  - **No em dashes (`—`) in prose sentences**: Use commas, colons, periods, or parentheticals. Em dashes are permitted only in code blocks, tables, or markdown list separators.
  - **Active voice with named actors**: Every sentence names the human or subsystem performing the action (e.g., "`store.ts` passes `--server localhost:8090`").
  - **No non-technical filler `-ly` adverbs**: Cut softeners/intensifiers ("simply", "actually", "genuinely", "notably"); retain technical adverbs ("atomically", "synchronously", "deterministically").
  - **No throat-clearing openers or binary-contrast frames**: Cut "Here's the thing:", "It's worth noting", and `"Not X, it's Y"` tropes.

## 3. Luminous Graphviz Diagrams (`../graphviz-style`)
- **Semantic `.dot` Sources (`docs/diagrams/*.dot`)**:
  - Use semantic `class="..."` attributes (`primary`, `emphasis`, `accent`, `store`, `code`, `terminal`, `decision`, `external`, `async`, `weak`, `positive`, `warning`, `error`).
  - Never hardcode hex colors or font names in `.dot` files; styling comes exclusively from `../graphviz-style/theme/luminous.gvpr`.
  - Use `primary` at most once or twice per diagram.
- **Rendering & Verification (`make diagrams`)**:
  - Render both light and dark WebP variants:
    ```sh
    gvpr -c -f ../graphviz-style/theme/luminous.gvpr -a light <file>.dot | dot -Twebp -o <file>-light.webp
    gvpr -c -f ../graphviz-style/theme/luminous.gvpr -a dark  <file>.dot | dot -Twebp -o <file>-dark.webp
    ```
  - Verify `fc-match "Google Sans Flex"` and `fc-match "Google Sans Code"` resolve before rendering, and visually inspect the generated `.webp` files.
  - Commit `.dot` and `*-{light,dark}.webp` files; never commit intermediate `.png` or `.svg` files.

## 4. Automated WebP Screenshots & `<picture>` Embedding
- **Screenshots (`hack/screenshots.mjs` / `make screenshots`)**:
  - Capture all views at `1440×900` (`deviceScaleFactor: 2`) in both `data-theme="light"` and `data-theme="dark"`, convert via `cwebp -q 90`, and remove temporary `.png` files.
- **Theme-Aware Markdown Embedding**:
  - Always embed diagrams and screenshots in `README.md` and `docs/**` with `<picture>` so GitHub and local viewers switch themes automatically:
    ```html
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/01-architecture-dark.webp">
      <img alt="AX Central system architecture" src="docs/diagrams/01-architecture-light.webp">
    </picture>
    ```
