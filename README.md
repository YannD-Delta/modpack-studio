# Modpack Studio

Self-hosted local web app that maintains **LMP**, a custom modpack built on ATM10 (All the Mods 10, NeoForge).
It follows ATM's own logic: ATM10 client vs ATM10 server pack gives the client-only mods (the server blacklist),
then LMP vs ATM10 shows the mods Yann updated or added. Design and plans: [`docs/plans/`](docs/plans/).

Status: **phases 0-1** (foundation + mod comparison) done and reviewed. Next phases: config engine and harvest,
builds and boot test, deploy agent and publishing, Claude assistant.

## What works today

- Profiles matrix (pack x version x client/server x clean/launched/run), immutable snapshots, launch-artifact check
- Import of an ATM10 server-pack zip or a CurseForge instance `mods/` folder (jar metadata by mod id, jar-in-jar, libraries, duplicates, skipped jars)
- Mod diff by mod id (updated / added / removed / rebuilt, version ordering), anomalies (ATM mods missing from LMP) as build blockers
- NeoForge/Minecraft version agreement check across profiles
- ATM-derived server blacklist, decisions memory (side, pin, accept removal)
- French web UI (login, profiles, mods diff, blacklist, decisions and debug journal), SSE job events

Validated read-only against real CurseForge instances (ATM10 8.3, NeoForge 21.1.259).

## Decisions and debug journal

The **Décisions** page lists everything Studio remembers on Yann's behalf: pinned older versions, accepted removals,
forced sides and his own blacklist entries (ATM-derived rows are only counted, they are recomputed from the packs).
Each row can have its reason edited or be undone (inline confirmation); every change is written to the audit log, and
the diff and the blacklist read the database on every request, so an undo applies at once.
The **Débogage** area shows app facts (versions, data dir, database size, counts; never the config or any secret),
the audit log (search, paging, raw payload) and the jobs (status, progress, full error message, refreshed every 5 s).

| Method and path (under `/api/v1`) | Purpose |
| --- | --- |
| `GET /decisions` | decisions + Yann's blacklist rows + `atmDerivedCount` |
| `DELETE /decisions/:modId/:kind` | undo a `side`, `pin` or `ignore` decision (404 when absent) |
| `PUT /decisions/:modId/:kind/reason` | edit its reason (`{reason}`, 500 chars max) |
| `DELETE /blacklist/entry/:modId` | remove Yann's entry (404 absent, 409 ATM-derived) |
| `PUT /blacklist/entry/:modId/reason` | edit the reason of Yann's entry |
| `GET /debug/audit?limit=&before=&q=` | audit log newest first, `nextBefore` cursor, literal text search |
| `GET /debug/jobs?limit=&status=` | jobs newest first, params text capped at 2000 chars |
| `GET /debug/info` | versions, platform, uptime, data dir, database file/size/migrations, row counts |

## Config comparison (Configs page)

Compares the files of two profiles under `config/`, `defaultconfigs/`, `kubejs/`, `scripts/`, `datapacks/` and `global_packs/`
(folder instance or server-pack zip, with or without a single wrapper folder). Read-only: Studio never writes into an instance.

- **Scan** (job `scan-configs`, `POST /api/v1/configs/scan {profile, force?}`): streams and hashes every tracked file (sha256, size,
  text/binary). Skips `*.bak`, `*.tmp`, `*.log`, `Thumbs.db`, `.DS_Store`, `desktop.ini` and any `logs/`, `cache/`, `.cache/` folder;
  never follows symlinks or junctions; files above 5 MB are hashed only. Unreadable entries (path too long, locked, vanished) are
  listed as issues and the scan goes on. The result is cached in `<data>/cache/configs-<profileId>.json`: clean and launched
  profiles keep it until a forced rescan, `run` profiles are rescanned every time.
- **Diff** (`GET /configs/diff?base&other`): per file `identical`, `cosmetic` (bytes differ, settings do not: BOM, CRLF, trailing
  spaces; JSON/JSON5/mcmeta compared as key-sorted data with comments and trailing commas tolerated; TOML without comments, blank
  lines, indentation and spacing around `=`), `modified`, `onlyInBase`, `onlyInOther`, `binaryDiffers`, `tooLarge`. Contents are
  read only for differing text files up to 1 MB, and equality results are cached in memory per hash pair.
- **Details**: `GET /configs/file?profile&path` (text up to 1 MB, 415 for binary, strict relative-path checks) and
  `GET /configs/filediff?base&other&path` (Myers line diff, 5000 lines per side, unified hunks).
- **Update plan**: `GET|PUT /configs/plan` stores "take the reference's version" for `modified` and `onlyInBase` files
  (`update_plan_item`, kind `file`, key = relative path); the export that copies them into an update pack is a separate feature.

Limitations: no editor yet (files are only viewed), no 3-way merge, and agent profiles cannot be scanned.

## Quick start (Windows)

Double-click `Start.cmd` (or run `pwsh -File studio.ps1`): a menu offers first setup (Node.js check and install through winget,
dependencies, web build, password), start, demo mode, tests, packaging and the logon task.
Non-interactive: `studio.ps1 -Action setup|start|demo|password|build|test|package|task`.

## Run by hand

```bash
npm ci
npm run set-password          # reads the password from stdin, writes data/settings.json
npm run build:web
npm start                     # http://127.0.0.1:8480 (STUDIO_DATA=<dir> to change the data folder)
```

`npm test` (Vitest, synthetic fixtures only), `npm run typecheck`, `npm run dev:web` (Vite dev server with API proxy).
`npx tsx scripts/seed-demo.ts <dir>` builds throwaway synthetic data to look at the UI (password `demo`).

## Package and install (Windows)

```powershell
pwsh scripts/package.ps1 -Version 0.1.0 [-NodeExe <portable node.exe>]
pwsh scripts/install-task.ps1 -InstallDir D:\ModpackStudio          # dry run
pwsh scripts/install-task.ps1 -InstallDir D:\ModpackStudio -Apply   # logon task under the current user
```

Node 24 LTS is the runtime target (`engines`); development here used Node 25.4.

## Pinned versions (latest stable verified with `npm view` on 2026-10-29)

fastify 5.12.7, zod 4.6.7, better-sqlite3 13.0.3, drizzle-orm 0.45.4, drizzle-kit 0.31.11, piscina 5.3.2,
yauzl 3.4.0, yazl 3.3.1, @fastify/cookie 11.1.5, @fastify/rate-limit 11.2.1, @fastify/static 10.1.8, typescript 7.0.2,
vitest 5.0.5, tsx 4.23.15, react 19.3.1, vite 8.3.5, tailwindcss 4.3.3, @tanstack/react-query 5.105.0.

## Layout

`src/server` (api, jobs, db, blobs, zip, mods, loader, profiles), `src/web` (React + Tailwind, French),
`src/shared` (zod schemas, version ordering), `tests` (unit, api, fixtures-gen), `scripts` (package, install, seed-demo), `drizzle` (migrations).
