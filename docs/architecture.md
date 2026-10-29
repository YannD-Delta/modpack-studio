# Architecture

[← README](../README.md)

## Stack and why

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript on Node.js (24 LTS target, developed on 25) | One language for the API, the jar/zip handling and the UI; types shared through `src/shared` |
| API | Fastify 5 + zod 4 | Schema-validated routes under `/api/v1`, cookie sessions, rate limiting |
| Database | SQLite (better-sqlite3) + Drizzle migrations | Single local file, no service to run, migrations in `drizzle/` |
| Parallel work | piscina worker threads | Hashing jars (sha256) off the main thread |
| Archives | yauzl (read) / yazl (write) | Stream zips without extracting them |
| UI | React 19 + Vite + Tailwind 4 + TanStack Query/Virtual | Large tables stay smooth (virtualised), server state cached |
| AI | Official `@anthropic-ai/sdk` | Claude actions through the API ([details](claude-assistant.md)) |
| Tests | Vitest (synthetic fixtures only) | Never touches a real instance |
| Launcher | PowerShell + CMD (`Start.cmd`, `studio.ps1`) | Setup, start, demo, tests, packaging from one menu |

Pinned versions were checked against the registry on 2026-10-29: fastify 5.12.7, zod 4.6.7, better-sqlite3 13.0.3, drizzle-orm 0.45.4, drizzle-kit 0.31.11, piscina 5.3.2, yauzl 3.4.0, yazl 3.3.1, typescript 7.0.2, vitest 5.0.5, react 19.3.1, vite 8.3.5, tailwindcss 4.3.3, @tanstack/react-query 5.105.0. `npm audit` reports 0 vulnerabilities (an `overrides` entry pins a dev-only transitive `esbuild`).

## One process, local only

A single Node process serves the API and the built web UI on `127.0.0.1:8480`. It listens on loopback only and checks the `Host` and `Origin` headers. Everything it keeps lives in the **data folder** (`./data`, git-ignored):

| Path | Content |
|---|---|
| `studio.db` | SQLite: profiles, mods, decisions, plans, jobs, audit log |
| `settings.json` | Password hash (scrypt) and server settings |
| `secrets.json` | API keys, write-only ([Settings](settings.md)) |
| `preferences.json` | Assistant model/effort and the two pack names |
| `cache/` | Config inventories (`configs-<profileId>.json`) |
| `exports/` | Generated update packs |
| `tests/` | Server test runs with their logs ([Test bench](test-bench.md)) |

## Source layout

```
src/server/
  api/            Route files (routes-profiles, -mods, -configs, -plan, -assistant, -testbench, -settings, …)
  db/             Drizzle schema and client
  jobs/           Persisted jobs, SSE events, per-resource locks
  mods/           Jar import, diff, side classifier, blacklist, decisions, CurseForge sources
  configs/        Inventory scan, normalisation, diff, customization analysis
  plan/           Update plan and export
  loader/         Loader and Minecraft version detection
  profiles/       Profile service (declared state, launch-artifact check)
  testbench/      Throwaway server tests
  assistant/      Claude client and prompts
  settings/       Keys, preferences, pack names
  threadpool.ts   Libuv pool size guard, imported first by main.ts
src/web/          Pages, components, API clients, i18n JSON per work stream
src/shared/       zod schemas and version ordering
```

## Jobs

Anything slow (import, scan, export, test) is a **job**: a database row with a status and progress, started by a `POST` that returns at once, followed through Server-Sent Events. Jobs survive a refresh; on a restart, jobs that were running are marked *interrupted*. Each job declares **lock keys** (for example the profile it reads), so two jobs on the same resource never run together while unrelated ones do ([Performance](performance.md)).

## Database

Schema in `src/server/db/schema.ts`; migrations `0000` to `0003` (initial, import issues, update plan, jar source). After editing the schema: `npx drizzle-kit generate --name <name>`. Jar bytes are never stored: only metadata and the sha256 are.

## Running it

```powershell
Start.cmd                                    # interactive menu
pwsh -File studio.ps1 -Action setup|start|demo|password|build|test|package|task
```

By hand:

```powershell
npm ci
npm run set-password          # reads the password from stdin, writes data/settings.json
npm run build:web
npm start                     # STUDIO_DATA=<dir> changes the data folder
```

`npm run dev:web` runs the Vite dev server with an API proxy. `npx tsx scripts/seed-demo.ts <dir>` builds throwaway synthetic data (password `demo`). The launcher sets `UV_THREADPOOL_SIZE=32`: it must be set before Node starts.

## Packaging and logon task (Windows)

```powershell
pwsh scripts/package.ps1 -Version 0.1.0 [-NodeExe <portable node.exe>]
pwsh scripts/install-task.ps1 -InstallDir D:\ModpackStudio          # dry run
pwsh scripts/install-task.ps1 -InstallDir D:\ModpackStudio -Apply   # logon task, current user
```

## Debug area

The **Decisions** tab also holds app facts (versions, data folder, database size, row counts; never the configuration or a secret), the audit log (search, paging, raw payload) and the jobs (status, progress, full error). Routes: `GET /debug/info`, `GET /debug/audit`, `GET /debug/jobs`.
