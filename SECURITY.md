# Security policy

Modpack Studio is a local tool (it listens on 127.0.0.1 only), but the code is public.

## Supported versions

The latest commit on `main`.

## Reporting a vulnerability

Please do not open a public issue. Use the repository's Security tab and choose "Report a vulnerability" (GitHub's private advisory form). Include the commit, the steps to reproduce and the impact.

## Scope

- Authentication bypass.
- Path traversal in file routes or in update packs.
- API keys or tokens exposed in logs or API responses.
- Anything that makes Studio write into a Minecraft instance (exports are packs; only the user-run `apply.ps1` touches an instance, and it never deletes).
