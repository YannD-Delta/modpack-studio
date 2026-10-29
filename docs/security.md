# Security and guarantees

[← README](../README.md)

## Your instances

- Studio **reads** instances; it never writes into one. Changes leave as an [update pack](update-pack.md) that you apply with `apply.ps1`.
- `apply.ps1` is a dry run by default, verifies sha256, refuses to run while Java uses the instance, moves replaced files to a backup folder and **never deletes**.
- Immutable profiles (clean, launched) cannot be re-imported. A clean profile with launch traces is refused.
- The [test bench](test-bench.md) works on a copy, with Discord/map mods disabled in that copy only.

## The web app

- Listens on `127.0.0.1` only; `Host` and `Origin` are checked.
- Password hashed with scrypt; cookie session kept in memory (a restart logs out); login limited to 5 attempts per minute.
- All file paths received from the UI are validated as safe relative paths; symlinks and junctions are not followed.
- Jobs are persisted, run under per-resource locks, and are marked interrupted after a restart.

## Secrets

- API keys are write-only (last 4 characters shown), kept in `data/secrets.json`, never returned, logged or audited. Errors never include them.
- `data/` is git-ignored. No key, token, password, public address, domain or webhook belongs in a committed file; in notes a key is written `apikey=(removed)`.
- Claude prompts are built on demand and not stored.

## Project rules

Tests use synthetic fixtures only and never touch a real instance; `npm audit` must stay at 0 vulnerabilities. Details in [CLAUDE.md](../CLAUDE.md).
