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
- French web UI (login, profiles, mods diff, blacklist), SSE job events

Validated read-only against real CurseForge instances (ATM10 8.3, NeoForge 21.1.259).

## Run

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
