# Mod analysis

[← README](../README.md) · [Concepts](concepts.md)

## Import

A profile's mods come from a **folder instance** (`mods/`), a **CurseForge instance** or a **server pack zip**. Each jar is read once: mod id, version, declared loader and side, dependencies, jar-in-jar entries. Studio stores the metadata and the **sha256**, never the jar bytes. Duplicates, skipped jars and libraries are reported as import issues instead of being hidden. Hashing runs in worker threads ([Performance](performance.md)).

## Comparison by mod id

Two profiles are compared by **mod id**, not by file name. Each row gets one status and a plain-language reason ("`<own>` is out of date"), because version numbers are already shown beside it.

| Status | Meaning |
|---|---|
| missing | In the reference, absent from the compared profile |
| added | Only in the compared profile (your own addition) |
| out of date | Compared profile has an older version |
| newer | Compared profile has a newer version |
| rebuilt | Same version, different file (different sha256) |
| incomparable | Versions cannot be ordered (see below) |

Hovering a badge explains it (for example what *pinned* does). Each row has a **Details** panel (`GET /mods/:modId/debug`): both entries, why the versions order that way, decisions, plan state, duplicate ids, and a fresh sha256 of the reference jar, with a JSON copy button.

## Version ordering

Maven-like, in `src/shared`, with project rules:

- A lone trailing letter is a **patch letter**: `2.5.4b` is newer than `2.5.4`.
- `a`, `b`, `m` mean alpha / beta / milestone **only when glued to a digit** (`1.0b2`).
- Unknown qualifiers, hash-like suffixes and unresolved `${...}` placeholders make the pair **incomparable**; Studio says so rather than guessing.

## Sides and the server blacklist

Modpack authors publish a client pack and a server pack. **Base client mods minus base server mods = client-only mods**, and those are kept off your server. This is the **derived blacklist**, recomputed from the packs on every request. You add your own decisions on top:

| Decision | Effect |
|---|---|
| side | Force a mod to client-only or server |
| pin | Keep an older version; silences only the "out of date" status |
| ignore / accept removal | A base mod you deliberately removed stops raising an anomaly |

Decisions are remembered with an editable reason and can be undone (Decisions tab); every change is in the audit log.

## Anomalies

A **base mod missing from your pack** is an anomaly and **blocks a build** until you accept it. Duplicate mod ids inherited from the base pack do not block. Loader and Minecraft version must agree across profiles ([Concepts](concepts.md#loader-and-minecraft-version-detection)).

## Old pack migration

The **Old pack** tab imports an older pack and compares it to the base modpack: what is shared, what are candidates to bring over (with CurseForge links when known), and whether the loader and Minecraft version match. Claude can then advise ([Claude assistant](claude-assistant.md)).

Source: `src/server/mods/` (`diff.ts`, `side-classifier.ts`, `blacklist-service.ts`, `decisions-service.ts`).
