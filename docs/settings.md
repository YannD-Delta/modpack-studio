> Part of [Modpack Studio](../README.md) · created with Claude Code

# Settings

What this page covers: every setting that exists today and where it lives, the keys you can only change by editing a file, what happens when a settings file is damaged, and the limits that are still compiled into the code.

## What exists today

| Setting | Where it lives | Notes |
|---|---|---|
| Claude API key, CurseForge API key | `data/secrets.json` | **Write-only**: the UI shows only the last 4 characters; the API never returns a key. Stored as plain JSON (see [Security](security.md)) |
| Assistant model and effort | `data/preferences.json` | Settings tab. Models and effort levels (`low`, `medium`, `high`) are the lists in `src/server/settings/secrets-store.ts`. Defaults: `claude-sonnet-5-5`, `medium` |
| Limits, lists and patterns | `data/preferences.json`, section `limits` | Settings tab, card "Limits and lists" (see below). Neutral defaults; a value put back to its default is removed from the file |
| Pack names (base, yours) | `data/preferences.json` | Settings tab. Roles `upstream` and `own`; defaults `Base` and `Own` until you set your names |
| Password | `data/settings.json` | scrypt hash, set with `npm run set-password` (at least 8 characters, asked twice, hidden on a terminal; restart Studio afterwards) or by the launcher |
| `port` | `data/settings.json` | Default `8480` |
| `bindHost` | `data/settings.json` | Default `127.0.0.1` |
| `lanIp` | `data/settings.json` | Optional. Starts a second listener on that address and adds it to the allowed hosts |
| `allowedHosts` | `data/settings.json` | Extra `Host` names accepted besides `localhost`, `127.0.0.1`, `[::1]` and `lanIp`. Default empty |
| `STUDIO_DATA` | environment variable | Moves the whole data folder (default `./data`) |

The Settings tab has four cards: API keys, assistant (model and effort), pack names, and limits and lists. The keys in `settings.json` are not shown in the UI; you edit the file by hand and restart Studio.

`GET /settings` returns the key status, the assistant preferences, the pack names, the limits (with default, range and whether each is overridden) and the model and effort lists. Writers: `PUT /settings/keys`, `PUT /settings/assistant`, `PUT /settings/packs`, `PUT /settings/limits` (`{ "values": { "<key>": value | null } }`; `null` resets one; an unknown key, an out-of-range number, a bad list or an invalid pattern answers 400 `invalid_limit` and saves nothing).

### Server address keys

By default Studio listens on `127.0.0.1` over plain HTTP. If you set `lanIp`, the second listener is also plain HTTP: the password and the session cookie then travel in clear text on your network. Only do this on a network you trust, and keep `allowedHosts` as short as possible. If the LAN address is not assigned to this PC, Studio keeps running on the loopback address and retries the LAN listener every 30 seconds. See [Security](security.md).

## Keys

`PUT /settings/keys` stores a key, `DELETE /settings/keys/:provider` removes it, `POST /settings/keys/test` checks it (Claude through the SDK, CurseForge with a request to `api.curseforge.com`). A key's format is validated before it is stored. Saving a key writes an audit row with provider and the last 4 characters only.

## Pack names

The two names (up to 40 characters; letters, digits, space, `. _ + -`; must start with a letter or digit; distinct ignoring case) appear in the UI, in prompts and in the export folder names. `PUT /settings/packs` renames the existing database rows too, swap-safe (the two names can be exchanged). Profile creation rejects a pack name that is neither of the two. UI strings use `{upstream}` and `{own}` placeholders filled from these settings. A unit test checks four of the French translation files for the default placeholder words; it does not check every file or every possible real pack name, so keep real names out of translations by hand. Source: `src/server/settings/packs.ts`.

## Damaged files

- `preferences.json` and `secrets.json`: only a missing file counts as empty. A damaged file (bad JSON, wrong shape, locked) makes saves fail with HTTP 500 `settings_unreadable`; the file is left untouched and a copy is kept next to it as `<name>.corrupt-<timestamp>`. Reads of a damaged file fall back to defaults. A leading BOM is accepted. Writes go to a temp file and are renamed. A pack rename is refused before any database row changes.
- `settings.json`: a broken file stops startup with one line naming the file; there are no silent defaults.
- `studio.db` gets a rolling backup in `data/backups` at startup (last 5 kept).

## Limits and lists

Every module registers its own limits with a neutral default (the value that used to be a constant). The Settings tab edits them; they apply at once, except the tracked config folders, which apply from the next scan. A damaged or out-of-range value in the file falls back to the default.

| Key | Default | Range | Effect |
|---|---|---|---|
| `session.ttlHours` | 12 | 1 to 720 | Login session lifetime |
| `sse.recheckSeconds` | 15 | 1 to 600 | How often a live stream re-checks its session |
| `claude.timeoutSeconds` | 300 | 10 to 1800 | Wait for one Claude answer |
| `claude.maxTokens` | 16000 | 1000 to 64000 | Output budget of one answer |
| `backup.keep` | 5 | 1 to 50 | Database backups kept |
| `backup.minIntervalMinutes` | 60 | 0 to 1440 | Minimum time between two backups |
| `import.scanConcurrency` | 4 | 1 to 32 | Jars read at the same time during an import |
| `configs.maxTextMb` | 5 | 1 to 256 | Largest config file read as text (hash only above) |
| `configs.normalizeMaxKb` | 1024 | 64 to 65536 | Largest file compared as normalised text |
| `configs.maxViewKb` | 1024 | 64 to 65536 | Largest file shown in the viewer |
| `configs.maxDiffLines` | 5000 | 100 to 100000 | Lines compared in one file diff |
| `configs.maxDiffFiles` | 20000 | 100 to 200000 | Files compared in one analysis |
| `configs.trackedRoots` | `config`, `defaultconfigs`, `kubejs`, `scripts`, `datapacks`, `global_packs` | up to 30 folders | Folders scanned for configs |
| `testbench.maxConsoleLogMb` | 64 | 1 to 1024 | Console log kept per test |
| `testbench.freeSpaceMarginMb` | 512 | 0 to 102400 | Free space that must remain after the copy |
| `testbench.maxKeptCrashReports` | 20 | 0 to 200 | Crash reports kept per test |
| `testbench.defaultMemoryMb` | 8192 | 1024 to 65536 | Memory preset of the test form |
| `testbench.defaultPort` | 25570 | 1024 to 65535 | Port preset of the test form |
| `testbench.defaultTimeoutMinutes` | 10 | 1 to 60 | Wait for "Done" preset of the test form |
| `testbench.disabledJarPattern` | `discord|dcintegration|dynmap|bluemap` | regular expression | Jars renamed to `.jar.disabled` in the test copy |

## Limits that are still code constants

These values are compiled in today and are **planned** to join the table above (see the [roadmap](roadmap.md)).

| Area | Constant | Default today |
|---|---|---|
| Sessions | Login attempts | 5 per minute |
| Jobs | Jobs running at once | 4 |
| Performance | libuv thread pool (set by the launcher) | 32 |
| Config scan | Parallel reads, parallel diff reads | 16, 8 |
| Zip safety | Zip readers (import, loader check, export, config scan) | 500000 entries, compression ratio 1000 (shared constant); other zip uses 20000 entries, ratio 200 |
| Mods plan | Entries per plan request | 5000 |
| Assistant | Rows, log lines, crash lines per prompt | 400, 150, 120 |
| Lists | Test runs and exports shown | 50 each |
| Retention | Test runs, exports, audit rows | never pruned |

Retention has no setting: test run copies and exports stay on disk until you delete them.

Kept as constants on purpose: the Anthropic and CurseForge URLs, input size bounds, the version-ordering tables and UI layout tuning.
