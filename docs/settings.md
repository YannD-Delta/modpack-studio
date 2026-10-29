# Settings

[← README](../README.md)

| Setting | Where it lives | Notes |
|---|---|---|
| Password | `data/settings.json` | scrypt hash; set with `npm run set-password` or the launcher |
| API keys (Claude, CurseForge) | `data/secrets.json` | **Write-only**: the UI shows only the last 4 characters; never returned by the API, logged or audited |
| Assistant model and effort | `data/preferences.json` | Model list and effort levels in `src/server/settings/secrets-store.ts` |
| Pack names (base, yours) | `data/preferences.json` | Roles `upstream` and `own`; default placeholders are replaced by your names |

## Keys

`PUT /settings/keys` stores a key, `DELETE /settings/keys/:provider` removes it, `POST /settings/keys/test` checks it (Claude through the SDK, CurseForge with a request). A key's format is validated before it is stored.

## Pack names

The two names (letters, digits, space, `. _ + -`, up to 40 characters, distinct ignoring case) appear in the UI, in prompts and in the export folder names. `PUT /settings/packs` renames the existing database rows too, swap-safe (the two names can be exchanged). Profile creation rejects a pack name that is neither of the two. UI strings use `{upstream}` and `{own}` placeholders filled from these settings, and a test forbids hardcoded pack names in the translations. Source: `src/server/settings/packs.ts`.
