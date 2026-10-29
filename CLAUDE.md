# Modpack Studio

Local web app that maintains a custom modpack built on a base CurseForge modpack (`upstream` and `own` roles, names set in Settings): mod and config comparison between profiles,
base-derived server blacklist, update pack export, test bench, Claude assistant.
Documentation index: `README.md` and `docs/`; design records: `docs/plans/`. Keep the matching `docs/` page in the same commit as a behaviour change. Open tasks and pending decisions live in the private tracker (see `CLAUDE.local.md`, which is not committed).

## Commands

```powershell
$env:Path = $env:Path -replace '"',''     # Windows: drop an orphan quote from PATH before npm/node
npx tsc --noEmit                          # type check (must be clean)
npx vitest run                            # all tests (synthetic fixtures only)
npm run build:web                         # web bundle into dist/web
Start.cmd                                 # menu: setup, start, demo, tests, package (studio.ps1 -Action ...)
```

Server: `127.0.0.1:8480`, data in `./data` (git-ignored: `studio.db`, `settings.json`, `secrets.json`, `cache/`, `exports/`).

## Layout

- `src/server`: Fastify 5 routes under `/api/v1` (`api/routes-*.ts`), SQLite + Drizzle (`db/`, migrations in `drizzle/`), persisted jobs with SSE (`jobs/`), mod analysis (`mods/`), config scan and diff (`configs/`), update plan (`plan/`).
- `src/web`: React 19 + Tailwind 4. UI strings are French, in `src/web/i18n/fr*.json` (one file per work stream, merged in `i18n/index.ts`).
- `src/shared`: zod schemas and version ordering (Maven style; a lone trailing letter such as `2.5.4b` is a patch letter, `a`/`b`/`m` only mean alpha/beta/milestone when glued to a number).
- `tests`: Vitest. Never touch real instances or a network drive; generate synthetic jars and trees with `tests/fixtures-gen`.

## Rules

- Code, comments, identifiers, commits, README and docs are in English. Only UI strings are French.
- TDD: write the failing test first and watch it fail. `tsc` and `vitest` green before every commit.
- Commit footer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never push or publish without the user's explicit agreement.
- No secret anywhere in a committed file, log, error message or API response: API keys, tokens, passwords, public IPs, domains, webhooks. A key is written `apikey=(removed)`.
- Anonymise before anything goes to GitHub: no personal name, personal path, real pack name, IP, domain, account, key, token or webhook in a tracked file, test, doc or commit message. Packs are the "base modpack" and "your modpack". Before a push run `git grep -n -i` on the personal words, scan for key and IP patterns, and read `git diff origin/main --stat`. Pushed history is public and cannot be cleaned.
- Never hardcode what a user may want to change (pack names, ports, folders, model, thresholds, tracked or ignored lists, durations, limits): make it a setting in the Settings tab (`data/preferences.json`) with a neutral default. UI texts use `{upstream}` / `{own}` placeholders; a test forbids real names.
- Docs follow code: update `README.md` and the matching `docs/` page in the same commit as a behaviour change.
- Studio never writes into an instance: exports are packs with an `apply.ps1` that backs up before replacing and never deletes.
- New table: edit `src/server/db/schema.ts`, then `npx drizzle-kit generate --name <name>`.
- `UV_THREADPOOL_SIZE` must be set by the launcher (`studio.ps1`, `run.cmd`); setting it from code is too late.
