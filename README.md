# Modpack Studio

> **Created with [Claude Code](https://claude.com/claude-code).** This project (code, tests and documentation) is written by Claude Code, Anthropic's agentic coding tool, working with its maintainer. The documentation below is kept up to date the same way, in the same commits as the code.

A self-hosted web app that helps you maintain **your own Minecraft modpack, built on top of a base modpack** you follow (typically a big CurseForge modpack that ships new versions regularly).

Every time the base modpack updates, you have to redo your own pack: pick up what is new, keep your added mods and your settings, check that everything still starts, build the player zip and the server pack, and tell your players what changed. Modpack Studio compares, tests and prepares all of that for you. **It never writes into your instances**: it reads them, and prepares packages that you apply yourself.

Naming used everywhere in these docs:

| Term | Meaning | Code / settings name |
|---|---|---|
| **Base modpack** (`<base-modpack>`) | The upstream modpack you follow | role `upstream` |
| **Your modpack** (`<base-modpack>` + `<your-modification>`) | Your derived pack: the base plus your mods and settings | role `own` |

Both names are **settings** (Settings tab). Nothing about a specific modpack is hardcoded in the UI.

## What it does

- **Compares mods** between any two copies of a pack, by mod id (not file name), with a plain-language reason for every row: missing, added, out of date, newer, rebuilt.
- **Derives the server blacklist** from the base modpack's own client/server split, and remembers your decisions (pin a version, accept a removal, force a side).
- **Compares configs** (`config`, `kubejs`, `defaultconfigs`, …) and tells apart *what you changed* from *what the game regenerated*, using three copies of the pack: **clean**, **launched**, **played**.
- **Prepares update packs**: pick mods and config files into a plan, get a folder + zip + a safe `apply.ps1` (dry run by default, backups, nothing deleted).
- **Tests a server** headlessly: starts a throwaway copy next to your real one, waits for `Done`, stops it, keeps the logs.
- **Asks Claude** ready-made questions about the lists (are these updates worth it? are my added mods useful? what from my old pack is missing in the new base?), through the API or as a prompt you paste into claude.ai.
- Reads **CurseForge links** straight from each instance's `minecraftinstance.json` (no API key needed).

## The tabs

| Tab | Purpose |
|---|---|
| Profiles | The copies of each pack: version, side, state (clean / launched / played), location, import |
| Mods | Mod comparison, per-row reason, update plan, Claude buttons, per-row debug panel |
| Configs | "My changes" over three copies, or a free comparison of two profiles, with line diffs |
| Old pack | An old pack against the base modpack: what is missing, equivalents, loader/Minecraft check |
| Test bench | Throwaway server tests with kept logs and Claude analysis |
| Decisions | Everything Studio remembers for you, plus the audit log, jobs and system info |
| Blacklist | Mods kept off the server, derived from the base modpack plus your own |
| Settings | API keys, assistant model, the two pack names |

## Quick start (Windows)

```powershell
Start.cmd            # menu: setup, start, demo mode, tests, packaging
# or
pwsh -File studio.ps1 -Action setup
pwsh -File studio.ps1 -Action start      # http://127.0.0.1:8480
```

`setup` checks Node.js 24+ (offers to install it with winget), installs dependencies, builds the web UI and asks for a password. `demo` starts on synthetic data (password `demo`) so you can look around safely. More in [docs/architecture.md](docs/architecture.md#running-it).

## Documentation

Start with the concepts, then read what you need. Every page links to the source files it describes.

| Page | What it explains |
|---|---|
| [Concepts](docs/concepts.md) | Vocabulary, the two packs, profiles, **clean / launched / played** and how Studio tells them apart |
| [Architecture](docs/architecture.md) | Stack (and why), one-process design, database, jobs, data folder, running and packaging it |
| [Mod analysis](docs/mods-analysis.md) | Jar import, comparison by mod id, version ordering, sides, blacklist, loader agreement |
| [Config analysis](docs/configs-analysis.md) | Inventory, normalisation, the three-copy "what did I change" logic |
| [Update packs](docs/update-pack.md) | The plan, the export folder, `apply.ps1` |
| [Test bench](docs/test-bench.md) | Throwaway server tests and their safety rules |
| [Claude assistant](docs/claude-assistant.md) | Settings, the five ready-made actions, API vs copy-paste prompt |
| [CurseForge](docs/curseforge.md) | What is used today, what comes next, why players stay on CurseForge |
| [Performance and parallelism](docs/performance.md) | What runs in parallel, why scans were slow, what fixed it |
| [Release cycle](docs/release-cycle.md) | The full update cycle from a base release to the player announcement |
| [Settings](docs/settings.md) | Keys, preferences and pack names: where they live and how they are protected |
| [Security and guarantees](docs/security.md) | The rules that protect your instances and your secrets |
| [Roadmap](docs/roadmap.md) | What works, what is in progress, what is planned |

Older design records are kept in [docs/plans](docs/plans).

## Project status

Working today: profiles, mod comparison, blacklist and decisions, config comparison and the three-copy analysis, update plan and export, server test bench, Claude actions, CurseForge links, settings. Planned: base-release detection, candidate builds, full CurseForge and server packs, deployment, announcement message. See the [roadmap](docs/roadmap.md).

## Repository layout

```
src/server/   Fastify API, SQLite + Drizzle, jobs, mod and config analysis, test bench, Claude client
src/web/      React UI (strings in src/web/i18n, French today)
src/shared/   Schemas and the version ordering shared by both sides
drizzle/      Database migrations
tests/        Vitest suites on synthetic fixtures only
scripts/      Packaging, logon task, demo data
studio.ps1    Interactive launcher (Start.cmd opens it)
```

## Development

```powershell
npm ci
npx tsc --noEmit         # type check, must be clean
npx vitest run           # synthetic fixtures only
npm run build:web
npx drizzle-kit generate --name <name>   # after editing src/server/db/schema.ts
```

Conventions: code, comments, commits and docs are in English; tests come first and never touch real instances; no secret is ever written to a committed file, a log or an API response. Details in [CLAUDE.md](CLAUDE.md).

## Keeping the docs current

The docs describe the code as it is. A change that alters behaviour updates the matching page in the same commit.
