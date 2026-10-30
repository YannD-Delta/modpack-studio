> Part of [Modpack Studio](../README.md) · created with Claude Code

# Settings

What this page covers: every setting that exists today and where it lives, the keys you can only change by editing a file, what happens when a settings file is damaged, and the limits that are still compiled into the code.

## What exists today

| Setting | Where it lives | Notes |
|---|---|---|
| Claude API key, CurseForge API key | `data/secrets.json` | **Write-only**: the UI shows only the last 4 characters; the API never returns a key. Stored as plain JSON (see [Security](security.md)) |
| Assistant model and effort | `data/preferences.json` | Settings tab. Models and effort levels (`low`, `medium`, `high`) are the lists in `src/server/settings/secrets-store.ts`. Defaults: `claude-sonnet-5-5`, `medium` |
| Pack names (base, yours) | `data/preferences.json` | Settings tab. Roles `upstream` and `own`; defaults `Base` and `Own` until you set your names |
| Password | `data/settings.json` | scrypt hash, set with `npm run set-password` (at least 8 characters, asked twice, hidden on a terminal; restart Studio afterwards) or by the launcher |
| `port` | `data/settings.json` | Default `8480` |
| `bindHost` | `data/settings.json` | Default `127.0.0.1` |
| `lanIp` | `data/settings.json` | Optional. Starts a second listener on that address and adds it to the allowed hosts |
| `allowedHosts` | `data/settings.json` | Extra `Host` names accepted besides `localhost`, `127.0.0.1`, `[::1]` and `lanIp`. Default empty |
| `STUDIO_DATA` | environment variable | Moves the whole data folder (default `./data`) |

The Settings tab has three cards: API keys, assistant (model and effort), and pack names. The keys in `settings.json` are not shown in the UI; you edit the file by hand and restart Studio.

`GET /settings` returns the key status, the assistant preferences, the pack names and the model and effort lists. Writers: `PUT /settings/keys`, `PUT /settings/assistant`, `PUT /settings/packs`.

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

## Limits that are still code constants

These values are compiled in today. The project rule is that anything a user may want to change becomes a setting with a neutral default; these are **planned** to move to the Settings tab as a typed preferences layer (design proposed, not built; see the [roadmap](roadmap.md) for what is scheduled). Until then, changing one means editing the code.

| Area | Constant | Default today |
|---|---|---|
| Sessions | Session lifetime | 12 hours |
| Sessions | Login attempts | 5 per minute |
| Jobs | Jobs running at once | 4 |
| Performance | libuv thread pool (set by the launcher) | 32 |
| Config scan | Tracked folders | `config`, `defaultconfigs`, `kubejs`, `scripts`, `datapacks`, `global_packs` |
| Config scan | Text read for comparison | 5 MiB, hash only above |
| Config scan | Normalised comparison and file viewer | 1 MiB each (two separate constants) |
| Config scan | Lines in one diff view | 5000 |
| Config scan | Files in one diff | 20000 |
| Config scan | Parallel reads, parallel diff reads | 16, 8 |
| Zip safety | Zip readers (import, loader check, export, config scan) | 500000 entries, compression ratio 1000 (shared constant); other zip uses 20000 entries, ratio 200 |
| Mods plan | Entries per plan request | 5000 |
| Assistant | Rows, log lines, crash lines per prompt | 400, 150, 120 |
| Assistant | Answer budget, timeout | 16000 tokens, 5 minutes |
| Test bench | Memory, port, timeout (per run, set in the form) | 8192 MB, 25570, 10 minutes |
| Test bench | Mods disabled in the test copy | names matching discord, dcintegration, dynmap, bluemap |
| Lists | Test runs and exports shown | 50 each |
| Retention | Test runs, exports, audit rows | never pruned |

The test bench memory, port and timeout are form fields of each run, not stored settings. Retention has no setting: test run copies and exports stay on disk until you delete them.

Kept as constants on purpose: the Anthropic and CurseForge URLs, input size bounds, the version-ordering tables, the SSE heartbeat (15 s) and UI layout tuning.
