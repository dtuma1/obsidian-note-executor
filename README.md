# obsidian-note-executor

Obsidian plugin that works on **desktop and mobile** (iOS/Android). It watches for new notes and "executes" them in one of two ways:

- **Run JS**: if the note's frontmatter contains `run: js` and the *Allow running JS from notes* setting is enabled (off by default), the note's first `` ```js `` fenced code block is executed with `app`, `plugin`, `file`, and `content` in scope. If no JS code block is present, the note is skipped (never executed as a whole).
- **Webhook**: otherwise, if a webhook URL is configured, the note is POSTed there as JSON (`path`, `name`, `frontmatter`, `content`, `ctime`, `mtime`).

New notes are detected via the vault `create` event plus metadata `changed` events, so notes whose content arrives later (e.g. via sync) are still processed. Frontmatter is parsed directly from the note content, not from the metadata cache. Each note is processed only once; the processed set is persisted across restarts (bounded to the most recent 1000 paths).

Commands: **Process active note** and **Process all notes in vault**. A folder filter setting limits which notes are reacted to.

## Install (including mobile)

Copy `manifest.json` and the built `main.js` into `<vault>/.obsidian/plugins/note-executor/` — on mobile, via Obsidian Sync or by placing the files into the vault folder with a file manager. Then enable the plugin in **Settings → Community plugins**.

## Build

```sh
npm install
npm run build   # type-checks and produces main.js
npm run dev     # watch mode
```

## Security

JS execution is disabled by default and additionally requires `run: js` in the note's frontmatter. When enabled, treat vault content as trusted — a note can run arbitrary code inside Obsidian. The webhook URL is stored in local plugin data only and is never committed.

No Node.js APIs are used, so the plugin is fully mobile-compatible (`isDesktopOnly: false`).
