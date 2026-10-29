# CurseForge

[← README](../README.md)

## Why players stay on CurseForge

Distribution stays on CurseForge: players already use its app, updates reach them without extra tooling, and your pack is published like the base one. A custom installer and launcher (packwiz on GitHub with a launcher such as Prism, or a launcher of your own) was researched and set aside: it would add maintenance, and a launcher with Microsoft login needs Mojang approval.

## Used today: links from instances

Each CurseForge instance holds `minecraftinstance.json`. For every mod it contains `addonID`, `installedFile.id`, `fileNameOnDisk` and `webSiteURL`. Studio reads them during import (`src/server/mods/curseforge-sources.ts`), stores them in table `jar_source` (migration `0003`) and shows a link on every mod row. **No API key is needed.**

## Planned: API client

Needs a CurseForge API key (header `x-api-key`, base `https://api.curseforge.com`), entered in Settings ([Settings](settings.md)). Planned uses:

- Identify unknown jars by fingerprint (`POST /v1/fingerprints/{gameId}`).
- List newer files of a mod (`GET /v1/mods/{id}/files`, filtered by loader; NeoForge has its own `modLoaderType`).
- Fetch changelogs for the release announcement.

Not confirmed yet: the fingerprint algorithm, the Minecraft game id and how files with distribution disabled behave. These will be verified against the official documentation before any code is written.

See also the [release cycle](release-cycle.md) for where CurseForge publication fits.
