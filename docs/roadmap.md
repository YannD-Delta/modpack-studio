# Roadmap

[← README](../README.md)

## Working today

- Profiles matrix, immutable snapshots, launch-artifact check, import of folders, CurseForge instances and server pack zips
- Mod comparison with reasons, version ordering, blacklist, decisions, anomalies, loader agreement
- Config comparison, normalisation, three-copy customization analysis
- Update plan, export folder and zip, safe `apply.ps1`
- Server test bench with kept logs
- Claude actions (API and copy-paste), settings (keys, model, pack names)
- CurseForge links read from instances

## Planned

| Area | Item |
|---|---|
| Release cycle | Base-release detection; candidate build; copy clean to launched; see [Release cycle](release-cycle.md) |
| Packs | Full CurseForge zips and server pack builder |
| Tests | Client test without a paid account (spike: launcher choice and offline accounts) |
| CurseForge | API client: fingerprints, newer files, changelogs ([CurseForge](curseforge.md)) |
| Deploy | Update the played server and push it to the host panel |
| Announce | Discord message from the changelog, through a webhook set in Settings |
| Config | Three-way merge for files changed on both sides |
| Quality | Neutral default pack names and fixtures in the code |

## Open questions

Tracked privately by the maintainer; the answers end up here and in the docs they change.
