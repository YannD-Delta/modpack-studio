# Modpack Studio, Phases 0-1 (foundation + mod comparison) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Yann's standing preference: inline execution, no subagent-driven development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Studio skeleton (auth, DB, blob store, jobs, safe filesystem, profiles) and the first usable feature: import ATM10-server / ATM10-client / LMP-client mod sets, compare them by mod id, check the loader version, derive the server blacklist from ATM's own choices, record decisions.

**Architecture:** One Node/TypeScript Fastify process (REST `/api/v1` + one SSE stream) with SQLite metadata, an on-disk sha256 blob store, and a persisted job runner with a `piscina` worker pool for jar scanning. A React/Vite SPA (French) sits on top. Pure domain modules (version comparison, jar metadata, mod diff, side cascade) have no I/O so they test against synthetic fixtures.

**Tech Stack:** Node 24 LTS (runtime pin; this dev PC has Node 25.4.0, so use only features present in 24), TypeScript, Fastify, zod, better-sqlite3 + Drizzle, piscina, yauzl/yazl, React + Vite + TanStack Query/Table/Virtual, Vitest, Playwright.

**Spec:** `C:\Users\compt\Server\docs\plans\2026-10-29-modpack-studio-conception.md` (v2). Later phases (config engine + harvest, builds + boot test, deploy agent + publish, Claude assistant) each get their own plan after this one ships.

**Project folder:** `C:\Users\compt\Server\modpack-studio\` (new git repo, local commits only, never pushed). Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Global Constraints

- Runtime Node 24 LTS, TypeScript; Fastify REST under `/api/v1`; zod schemas in `src/shared/schemas` shared by API and UI.
- SQLite via `better-sqlite3` + Drizzle migrations; blobs on disk (sha256-addressed, reference-counted), never in SQLite.
- Mods compared by **top-level mod id** read from each jar, never by file name; jar-in-jar is informational; a duplicate top-level id blocks the build.
- Version ordering = Maven `ComparableVersion`; unorderable strings report `different`, never "upgrade".
- Never write to a server or client instance while its process runs; SMB sources are opened read-only.
- Studio runs as a logon task under Yann's user account; binds localhost + LAN IP only; password hashed with scrypt; cookie `HttpOnly` + `SameSite=Strict`; `Origin`/`Host` checked.
- Only synthetic fixtures in tests; no test touches real modpack files; secrets never reach logs, UI or DB in clear text.
- UI copy in French; identifiers, comments, logs, commits and docs in English.
- Verify every dependency's latest stable version with `npm view <pkg> version` before pinning it (Task 1).

## Review Focus

1. A jar that declares several mod ids, nests jars (jar-in-jar), or is a library with no mod id: must not be double-counted or crash the import (Tasks 11, 12).
2. Version strings that cannot be ordered (`ABC` vs `DEF`, placeholders like `${file.jarVersion}`): reported as `different`, never as an upgrade (Tasks 10, 14).
3. Hostile or odd zips: `..` entries, zip bombs, entries differing only by case, nested zip depth (Task 4).
4. ATM10 client and server versions that disagree: side derivation must refuse, not guess (Task 14).
5. Folders that are empty, missing, contain a corrupt jar, or live at a path with spaces, accents or a UNC prefix: import reports and continues (Tasks 2, 12).

---

## File Structure

```
modpack-studio/
  package.json  tsconfig.json  vitest.config.ts  drizzle.config.ts  .gitignore
  src/shared/{versions.ts, schemas/*.ts, constants.ts}
  src/server/
    config.ts  main.ts
    fs-safe/safe-path.ts
    zip/zip-reader.ts
    db/{schema.ts, open.ts}   drizzle/ (generated SQL)
    blobs/blob-store.ts
    jobs/{runner.ts, pool.ts}
    api/{app.ts, auth.ts, events.ts, routes-profiles.ts, routes-mods.ts}
    profiles/profile-service.ts
    mods/{jar-meta.ts, import-modset.ts, diff.ts, side-classifier.ts, modrinth.ts, blacklist-service.ts}
    loader/detect-loader.ts
  src/web/{main.tsx, App.tsx, pages/{Login,Profiles,Mods,Blacklist}.tsx, i18n/fr.json}
  tests/{fixtures-gen/*.ts, unit/**, api/**, e2e/**}
  scripts/{package.ps1, install-task.ps1}
```

---

### Task 1: Project skeleton

**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/shared/constants.ts`, `tests/unit/constants.test.ts`.

**Interfaces:** Produces `APP_NAME: string` (`'modpack-studio'`), `API_PREFIX: string` (`'/api/v1'`).

- [ ] **Step 1:** `git init` in `C:\Users\compt\Server\modpack-studio`; `.gitignore` excludes `node_modules/`, `dist/`, `data/`, `*.db`, `.env*`, `private/`.
- [ ] **Step 2:** For each package in the Tech Stack run `npm view <pkg> version`; install exactly those versions; set `"type": "module"` and `"engines": {"node": ">=24"}`; record the versions in `README.md`.
- [ ] **Step 3: Write the failing test** `tests/unit/constants.test.ts`: `expect(APP_NAME).toBe('modpack-studio'); expect(API_PREFIX).toBe('/api/v1')`.
- [ ] **Step 4:** Run `npx vitest run` (expect FAIL: module missing), implement `src/shared/constants.ts`, run again (expect PASS).
- [ ] **Step 5:** Commit `chore: project skeleton`.

### Task 2: Safe paths

**Files:** Create `src/server/fs-safe/safe-path.ts`; Test `tests/unit/safe-path.test.ts`.

**Interfaces:** Produces `safeResolve(root: string, rel: string): string` (returns the absolute path or throws `PathEscapeError`); `class PathEscapeError extends Error`.

- [ ] **Step 1: Failing tests** (each `expect(() => safeResolve(root, X)).toThrow(PathEscapeError)`): `..\\x`, `a\\..\\..\\x`, `C:\\Windows`, `\\\\host\\share\\f`, `file.txt:stream`, `CON`, `nul.txt`, `name. ` (trailing dot/space), and a junction created with `fs.symlink(outside, join(root,'link'), 'junction')` then `link\\secret.txt`.
- [ ] **Step 2: Passing tests**: `safeResolve(root, 'config\\mod é.toml')` returns a path inside `root` (accents, spaces); root comparison is case-insensitive; a root given as a UNC string (`\\\\srv\\share\\pack`) resolves its children.
- [ ] **Step 3:** Run (FAIL), implement with `path.resolve` + `fs.realpathSync` on the deepest existing ancestor and a prefix check; run (PASS); commit `feat: safe path resolution`.

### Task 3: Synthetic fixture generator

**Files:** Create `tests/fixtures-gen/jar.ts`, `tests/fixtures-gen/packs.ts`; Test `tests/unit/fixtures-gen.test.ts`.

**Interfaces:** Produces
`type JarSpec = { fileName: string; loader: 'neoforge'|'forge'|'fabric'; mods: {modId: string; version: string; dependencySide?: 'CLIENT'|'SERVER'|'BOTH'}[]; nested?: JarSpec[]; library?: boolean; placeholderVersion?: boolean; manifestVersion?: string }`;
`makeJar(spec: JarSpec): Promise<Buffer>`; `makeZip(entries: Record<string, Buffer|string>, opts?: {wrapperDir?: string}): Promise<Buffer>`;
`writeAtmPack(dir: string, v: {atm: string; neoforge: string; mc: string; serverMods: JarSpec[]; clientMods: JarSpec[]}): Promise<{serverZip: string; clientDir: string}>` (server zip contains `mods/`, `startserver.bat` with `NEOFORGE_VERSION`, `neoforge-<ver>-installer.jar`; client dir contains `mods/*.jar` and `minecraftinstance.json` with `baseModLoader`).

- [ ] **Step 1: Failing test**: `makeJar({fileName:'a-1.0.jar', loader:'neoforge', mods:[{modId:'a', version:'1.0'}]})` opened with `yauzl` contains `META-INF/neoforge.mods.toml` whose text includes `modId = "a"`; a `nested` spec adds `META-INF/jarjar/metadata.json` and the nested jar entry; `library:true` writes no mods toml but a `Automatic-Module-Name` manifest line.
- [ ] **Step 2:** Run (FAIL); implement with `yazl`; run (PASS); commit `test: synthetic jar and pack fixtures`.

### Task 4: Zip reader with limits

**Files:** Create `src/server/zip/zip-reader.ts`; Test `tests/unit/zip-reader.test.ts`.

**Interfaces:** Consumes `makeZip` (Task 3). Produces
`type ZipLimits = { maxEntries: number; maxTotalBytes: number; maxEntryBytes: number; maxRatio: number; maxDepth: number }` with defaults `{20000, 8 GiB, 512 MiB, 200, 3}`;
`openZip(source: string | Buffer, limits?: Partial<ZipLimits>): Promise<ZipHandle>`; `ZipHandle { entries(): {name: string; size: number}[]; read(name: string): Promise<Buffer>; nested(name: string): Promise<ZipHandle>; close(): Promise<void> }`; errors `ZipSlipError`, `ZipLimitError`, `CaseCollisionError`.

- [ ] **Step 1: Failing tests**: an entry named `..\\evil.txt` or `/abs` throws `ZipSlipError` at `openZip`; 30000 tiny entries with `maxEntries: 20000` throws `ZipLimitError`; a 200 MB zero-filled entry with ratio > 200 throws `ZipLimitError` on `read`; entries `Mods/A.jar` and `mods/a.jar` throw `CaseCollisionError`; `nested()` four levels deep throws `ZipLimitError`; nested read of a jar inside a zip works from a Buffer; a zip with a wrapper folder lists names unchanged.
- [ ] **Step 2:** Run (FAIL), implement on `yauzl` (lazy entries, `fromBuffer` for nested), run (PASS), commit `feat: zip reader with slip/bomb/case guards`.

### Task 5: Database and migrations

**Files:** Create `src/server/db/schema.ts`, `src/server/db/open.ts`, `drizzle.config.ts`; generate `drizzle/`; Test `tests/unit/db.test.ts`.

**Interfaces:** Produces `openDb(file: string, opts?: {backupDir?: string}): Db` (WAL, `foreign_keys=ON`, runs pending migrations; copies the DB to `backupDir` before applying a migration); tables (Drizzle): `pack_version(id, pack, version, mc, loader, loader_version, base_atm_version?, lmp_hotfix?)`, `profile(id, pack_version_id, side, state, location_kind, location, captured_at, manifest_hash, immutable)`, `jar(sha256 pk, filename, size)`, `jar_mod(id, jar_sha256, profile_id, mod_id, version, declared_side, is_jij, parent_jar, library_key?)`, `mod_decision(mod_id, kind, side?, reason, created_at)`, `blacklist(mod_id, origin, valid_for, reason)`, `blob(sha256 pk, size, refs)`, `job`, `setting`, `audit_log`, `event`.

- [ ] **Step 1: Failing tests**: `openDb(':memory:')` has every table above; inserting a `profile` with a missing `pack_version_id` fails (foreign keys); with `backupDir` and a pre-existing older-schema file, opening creates a backup copy before migrating.
- [ ] **Step 2:** Run (FAIL), write the schema, `npx drizzle-kit generate`, implement `openDb`; run (PASS); commit `feat: sqlite schema and migrations`.

### Task 6: Blob store

**Files:** Create `src/server/blobs/blob-store.ts`; Test `tests/unit/blob-store.test.ts`.

**Interfaces:** Consumes `Db` (Task 5). Produces `class BlobStore { constructor(dir: string, db: Db); put(data: Buffer | NodeJS.ReadableStream): Promise<{sha256: string; size: number}>; get(sha256: string): NodeJS.ReadableStream; has(sha256: string): boolean; ref(sha256: string): void; unref(sha256: string): void; gc(): Promise<number>; verify(sha256: string): Promise<boolean> }`.

- [ ] **Step 1: Failing tests**: putting identical content twice stores one file; `unref` to 0 then `gc()` removes it and returns 1; a stream that errors mid-write leaves no file; flipping a byte on disk makes `verify` return false; file layout is `dir/ab/abcdef...`.
- [ ] **Step 2:** Run (FAIL); implement (temp file in same dir, fsync, rename; retry rename on `EPERM`/`EBUSY` 3 times); run (PASS); commit `feat: content-addressed blob store`.

### Task 7: Job runner

**Files:** Create `src/server/jobs/runner.ts`, `src/server/jobs/pool.ts`; Test `tests/unit/job-runner.test.ts`.

**Interfaces:** Consumes `Db`. Produces `class JobRunner { constructor(db: Db); register(type: string, fn: (ctx: JobContext) => Promise<unknown>): void; enqueue(type: string, params: unknown, opts?: {lockKey?: string}): string; cancel(id: string): void; on(listener: (e: JobEvent) => void): () => void }`, `JobContext {params: unknown; signal: AbortSignal; progress(pct: number, msg?: string): void}`, `JobEvent {id: string; type: string; status: 'queued'|'running'|'done'|'failed'|'cancelled'|'interrupted'; progress?: number; message?: string}`; `runInPool<T>(task: string, payload: unknown): Promise<T>` (piscina).

- [ ] **Step 1: Failing tests**: two jobs with the same `lockKey` never overlap; `cancel` aborts the signal and ends in `cancelled`; a job left `running` in the DB becomes `interrupted` when a new `JobRunner` is constructed; events for one job arrive in order queued, running, progress, done.
- [ ] **Step 2:** Run (FAIL), implement, run (PASS), commit `feat: persisted job runner`.

### Task 8: API skeleton, auth, SSE

**Files:** Create `src/server/config.ts`, `src/server/api/{app.ts, auth.ts, events.ts}`, `src/server/main.ts`; Test `tests/api/auth.test.ts`.

**Interfaces:** Consumes `Db`, `JobRunner`. Produces `loadConfig(dataDir: string): Config` (zod; `bindHost` default `127.0.0.1`, optional `lanIp`, `passwordHash`), `hashPassword(pw: string): string`, `verifyPassword(pw: string, hash: string): boolean` (scrypt), `buildApp(deps: {db: Db; jobs: JobRunner; config: Config}): FastifyInstance`; routes `GET /api/v1/health` (public), `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/events` (SSE of `JobEvent`).

- [ ] **Step 1: Failing tests** (`app.inject`): `/health` returns 200 unauthenticated; any other route returns 401 without a session; a request whose `Origin` host differs from `Host` returns 403; login with a wrong password returns 401, the sixth attempt within a minute returns 429; successful login sets a cookie containing `HttpOnly` and `SameSite=Strict`; an authenticated SSE client receives the `queued` and `done` events of an enqueued job.
- [ ] **Step 2:** Run (FAIL), implement, run (PASS), commit `feat: api skeleton with auth and sse`.

### Task 9: Profile service

**Files:** Create `src/server/profiles/profile-service.ts`; Test `tests/unit/profile-service.test.ts`.

**Interfaces:** Consumes `Db`, `safeResolve`. Produces `createProfile(db: Db, input: NewProfile, deps?: {isProcessRunning?: (dir: string) => boolean}): Profile` where `NewProfile = {pack: 'ATM10'|'LMP'; version: string; side: 'client'|'server'; state: 'clean'|'launched'|'run'; locationKind: 'zip'|'folder'|'smb'|'agent'; location: string}`; `detectLaunchArtifacts(dir: string): string[]` (finds `logs/`, `options.txt`, `*.bak`, `world/`); `listMatrix(db: Db): ProfileMatrix` (rows pack x version, columns side x state, empty cells allowed).

- [ ] **Step 1: Failing tests**: a `clean` profile over a folder containing `logs/` or `options.txt` throws `LaunchArtifactsError` listing them; a `run` profile is refused when `isProcessRunning` returns true; created profiles are `immutable` for `clean` and `launched` and cannot be updated; `listMatrix` returns old versions with only `clean` cells filled.
- [ ] **Step 2:** Run (FAIL), implement, run (PASS), commit `feat: profile service`.

### Task 10: Version comparator

**Files:** Create `src/shared/versions.ts`; Test `tests/unit/versions.test.ts`.

**Interfaces:** Produces `compareVersions(a: string, b: string): 'newer' | 'older' | 'equal' | 'incomparable'` (`newer` = `a` is newer than `b`).

- [ ] **Step 1: Failing tests**: `('1.2.10','1.2.9')` newer; `('1.0-beta','1.0')` older; `('1.0-rc1','1.0-beta2')` newer; `('21.1.259','21.1.251')` newer; `('2.1.9-1.19.2-43.1.1','2.1.8-1.19.2-43.1.1')` newer; `('1.0','1.0.0')` equal; `('ABC','DEF')`, `('', '1.0')` and `('${file.jarVersion}','1.0')` incomparable.
- [ ] **Step 2:** Run (FAIL), implement Maven `ComparableVersion` rules (qualifier order alpha < beta < milestone < rc < snapshot < release < sp; non-numeric strings with no digits are incomparable), run (PASS), commit `feat: maven-style version comparison`.

### Task 11: Jar metadata reader

**Files:** Create `src/server/mods/jar-meta.ts`; Test `tests/unit/jar-meta.test.ts`.

**Interfaces:** Consumes `ZipHandle` (Task 4), fixtures (Task 3). Produces `type ModDecl = {modId: string; version: string; declaredSide: 'client'|'server'|'both'|'unknown'}`; `type JarInfo = {fileName: string; loader: 'neoforge'|'forge'|'fabric'|null; kind: 'mod'|'library'; mods: ModDecl[]; libraryKey?: string; nested: JarInfo[]}`; `readJarInfo(zip: ZipHandle, fileName: string): Promise<JarInfo>`.

- [ ] **Step 1: Failing tests**: `neoforge.mods.toml` wins over `mods.toml`; a jar with two `[[mods]]` returns two `mods`; `${file.jarVersion}` resolves from `Implementation-Version` in `MANIFEST.MF`, else from the file name (`a-1.2.3.jar` gives `1.2.3`); a dependency `side = "CLIENT"` only gives `declaredSide: 'client'`, `BOTH` or absent gives `both`; a fabric jar uses `fabric.mod.json` `environment`; a library jar returns `kind: 'library'` with `libraryKey = Automatic-Module-Name + ':' + sha1 fingerprint`; jar-in-jar entries listed in `META-INF/jarjar/metadata.json` appear in `nested`, never in `mods`; a corrupt toml returns `kind: 'library'` plus no throw.
- [ ] **Step 2:** Run (FAIL), implement, run (PASS), commit `feat: jar metadata reader`.

### Task 12: Mod-set import

**Files:** Create `src/server/mods/import-modset.ts`; Test `tests/unit/import-modset.test.ts`.

**Interfaces:** Consumes `readJarInfo`, `openZip`, `Db`, `runInPool`, `safeResolve`. Produces
`type ModSetSource = {kind: 'zip'; path: string} | {kind: 'folder'; path: string}`;
`importModSet(db: Db, source: ModSetSource, profileId: number, ctx: JobContext): Promise<ImportResult>` with `ImportResult = {imported: number; skipped: {file: string; reason: string}[]; duplicateIds: {modId: string; files: string[]}[]}`; it locates `mods/` in a zip with or without a wrapper folder, hashes each jar (sha256), writes `jar` + `jar_mod` rows (metadata only, no jar bytes), reports progress.

- [ ] **Step 1: Failing tests** (fixtures): a server zip with 5 mods imports 5; a wrapper-folder zip imports the same; a folder source works at a path with spaces and accents; a corrupt jar is in `skipped` and the rest import; two jars declaring the same top-level id appear in `duplicateIds`; re-importing unchanged files re-hashes (size+mtime is only a hint) and writes no duplicate rows; an empty or missing `mods/` returns `imported: 0` with a `skipped` reason, no throw.
- [ ] **Step 2:** Run (FAIL), implement, run (PASS), commit `feat: mod-set import`.

### Task 13: Loader detection

**Files:** Create `src/server/loader/detect-loader.ts`; Test `tests/unit/detect-loader.test.ts`.

**Interfaces:** Produces `type LoaderInfo = {loader: 'neoforge'|'forge'|'fabric'; loaderVersion: string; mcVersion: string | null}`; `detectLoader(source: {kind: 'serverZip'; path: string} | {kind: 'curseforgeInstance'; path: string}): Promise<LoaderInfo>`; `checkLoaderAgreement(infos: Record<string, LoaderInfo>): {ok: boolean; mismatches: {a: string; b: string; field: 'loader'|'loaderVersion'|'mcVersion'}[]}`.

- [ ] **Step 1: Failing tests**: server zip with `neoforge-21.1.259-installer.jar` and `NEOFORGE_VERSION=21.1.259` in `startserver.bat` gives `loaderVersion '21.1.259'`; a CurseForge instance `minecraftinstance.json` with `baseModLoader.name 'neoforge-21.1.209'` and `minecraftVersion '1.21.1'` gives those; installer filename and script disagreeing throws `LoaderConflictError`; `checkLoaderAgreement` flags `21.1.259` vs `21.1.251` as a `loaderVersion` mismatch and `ok: false`.
- [ ] **Step 2:** Run (FAIL), implement, run (PASS), commit `feat: loader detection and agreement check`.

### Task 14: Mod diff engine

**Files:** Create `src/server/mods/diff.ts`; Test `tests/unit/diff.test.ts`.

**Interfaces:** Consumes `compareVersions`. Produces `type ModEntry = {modId: string; version: string; sha256: string; file: string}`; `type ModSet = Map<string, ModEntry>`;
`diffModSets(base: ModSet, other: ModSet, opts?: {pins?: Set<string>}): {added: ModEntry[]; removed: ModEntry[]; updated: {modId: string; from: ModEntry; to: ModEntry; direction: 'newer'|'older'|'different'}[]; rebuilt: ModEntry[]; unchanged: number}`;
`deriveAtmSides(atmS: ModSet, atmC: ModSet, versions: {server: string; client: string}): {clientOnly: string[]; serverOnly: string[]; both: string[]}` (throws `AtmVersionMismatchError` when versions differ);
`yannLayer(lmpC: ModSet, atmC: ModSet): ReturnType<typeof diffModSets>`; `anomalies(atmC: ModSet, lmpC: ModSet, resolved?: Set<string>): ModEntry[]`; `buildBlockers(input: {anomalies: ModEntry[]; duplicateIds: {modId: string; files: string[]}[]}): {code: 'ANOMALY'|'DUPLICATE_ID'; modId: string}[]`.

- [ ] **Step 1: Failing tests**: same id with a different file name is `updated`, not removed+added; same id, same version, different sha256 is `rebuilt`; a lower version is `direction: 'older'`; unorderable versions give `'different'`; a pinned id is not reported; `deriveAtmSides` computes the three sets from fixtures and throws on `versions` mismatch (`'8.2'` vs `'8.3'`); `anomalies` lists ATM client mods missing from LMP and omits resolved ones; `buildBlockers` returns one entry per unresolved anomaly and per duplicate id.
- [ ] **Step 2:** Run (FAIL), implement, run (PASS), commit `feat: mod diff, atm side derivation, anomalies`.

### Task 15: Side classification cascade

**Files:** Create `src/server/mods/side-classifier.ts`, `src/server/mods/modrinth.ts`; Test `tests/unit/side-classifier.test.ts`, `tests/unit/modrinth.test.ts`.

**Interfaces:** Produces
`type Side = 'client'|'server'|'both'`; `type SideSignal = {origin: 'decision'|'atm'|'modrinth'|'declared'; side: Side; confidence: number}`;
`classifySide(signals: SideSignal[]): {side: Side | null; origin: string | null; uncertain: boolean}` (priority decision > atm > modrinth > declared; two signals of different sides at different priorities mark `uncertain: true`);
`class ModrinthClient { constructor(opts: {fetch: typeof fetch; userAgent: string; maxPerMinute?: number}); lookupByHashes(sha1s: string[]): Promise<Map<string, {environment: string}>> }` using bulk `POST /v2/version_files` (algorithm `sha1`); `environmentToSide(env: string): Side | null` (`client_only` to client, `server_only` to server, `client_and_server` and `client_or_server` to both).
Signals for boot-test proof, `@Mod(dist)`, CurseForge tags, community list and bytecode are added in later phases.

- [ ] **Step 1: Failing tests**: a decision beats an ATM signal; an ATM signal beats Modrinth; a Modrinth `client_only` against a declared `both` returns `side 'client'`, `uncertain: true`; no signals returns `side: null`; the client sends one bulk request for 300 hashes in chunks of at most 100 (fake `fetch`), sets the `User-Agent`, and waits when `maxPerMinute` is exceeded (fake timers).
- [ ] **Step 2:** Run (FAIL), implement, run (PASS), commit `feat: side classification cascade and modrinth client`.

### Task 16: Blacklist and decisions

**Files:** Create `src/server/mods/blacklist-service.ts`; Test `tests/unit/blacklist-service.test.ts`.

**Interfaces:** Consumes `Db`. Produces `recomputeAtmDerived(db: Db, atmVersion: string, clientOnlyIds: string[]): void` (replaces `origin='atm_derived'` rows, never touches `origin='yann'`); `setDecision(db: Db, d: {modId: string; kind: 'side'|'pin'|'ignore'; side?: Side; reason: string}): void`; `effectiveBlacklist(db: Db, atmVersion: string): {modId: string; origin: 'atm_derived'|'yann'; stale: boolean}[]` (`stale` when `valid_for` differs from `atmVersion`).

- [ ] **Step 1: Failing tests**: recompute for `8.3` replaces the `8.2` derived rows and keeps a `yann` row; a `valid_for 8.2` row is `stale` when asked for `8.3`; a `pin` decision persists across recompute; every write adds an `audit_log` row.
- [ ] **Step 2:** Run (FAIL), implement, run (PASS), commit `feat: blacklist and decisions memory`.

### Task 17: Phase 1 API routes

**Files:** Create `src/server/api/routes-profiles.ts`, `src/server/api/routes-mods.ts`, `src/shared/schemas/{profile,mods}.ts`; Test `tests/api/phase1.test.ts`.

**Interfaces:** Consumes Tasks 5-16. Produces (all authenticated, zod-validated, writes audited): `POST /api/v1/profiles` (body `NewProfile`), `GET /api/v1/profiles/matrix`, `POST /api/v1/profiles/:id/import` (returns a job id; body `ModSetSource`), `GET /api/v1/mods/diff?base=<profileId>&other=<profileId>`, `GET /api/v1/mods/atm-sides?server=<profileId>&client=<profileId>`, `GET /api/v1/mods/anomalies?atmClient=<id>&lmp=<id>`, `GET /api/v1/loader/check?profiles=<ids>`, `GET /api/v1/build/blockers`, `GET|PUT /api/v1/blacklist`, `PUT /api/v1/mods/:modId/decision`.

- [ ] **Step 1: Failing tests** (`app.inject` + `writeAtmPack`): end to end, create three profiles, import them, `atm-sides` returns the client-only ids, `diff` returns the updated LMP mod, `loader/check` returns `ok: false` for mismatching NeoForge versions, `build/blockers` returns an `ANOMALY` for a dropped ATM mod and is empty after `PUT decision` resolves it; a bad body returns 400 with the zod message; an unauthenticated call returns 401.
- [ ] **Step 2:** Run (FAIL), implement, run (PASS), commit `feat: phase 1 api`.

### Task 18: Web UI (French)

**Files:** Create `src/web/{main.tsx, App.tsx, pages/Login.tsx, pages/Profiles.tsx, pages/Mods.tsx, pages/Blacklist.tsx, i18n/fr.json}`, `vite.config.ts`; Test `tests/unit/web/*.test.tsx`, `tests/e2e/smoke.spec.ts`.

**Interfaces:** Consumes the Task 17 API. Produces pages: Login; Profils (matrix with existing and missing cells, import form); Mods (virtualized diff table filterable by status `ajouté / retiré / mis à jour / reconstruit / anomalie` and by side, with a per-row decision menu); Liste noire (ATM-derived entries with a one-click "ajouter tout", stale entries flagged).

- [ ] **Step 1: Failing component tests** (Vitest + Testing Library): the matrix renders filled and empty cells; the diff table shows the French labels and updates the row when a decision is submitted; the blacklist page calls `PUT /api/v1/blacklist` once for "ajouter tout"; the login form shows an error on 401.
- [ ] **Step 2:** Run (FAIL), implement with shadcn/ui + Tailwind (dark theme, one accent colour, semantic status colours with icon + text), run (PASS).
- [ ] **Step 3: Playwright smoke** `smoke.spec.ts`: log in, import the generated fixtures, open Mods, see an "anomalie" row.
- [ ] **Step 4:** Run the app (`preview_start`), take screenshots of each page, iterate the visual polish with the `waza:ui` skill; commit `feat: web ui phase 1`.

### Task 19: Packaging and logon task

**Files:** Create `scripts/package.ps1`, `scripts/install-task.ps1`; Test: manual verification steps below.

**Interfaces:** Produces `package.ps1 -Version <x.y.z>` (builds `dist/modpack-studio-<x.y.z>.zip` with `versions/<x.y.z>/` and a `current` pointer file, a SHA-256 file, the data directory excluded); `install-task.ps1 [-Apply]` (registers a Task Scheduler logon task for the current user running `current\run.cmd`; **dry-run by default**, prints what it would register).

- [ ] **Step 1:** Run `pwsh scripts/package.ps1 -Version 0.1.0`; expected: the zip and its SHA-256 exist, `data/` is absent from the zip, `Get-FileHash` matches the sidecar.
- [ ] **Step 2:** Run `pwsh scripts/install-task.ps1` without `-Apply`; expected: prints the task name, trigger (at logon), user and command, and registers nothing (`Get-ScheduledTask` finds no such task).
- [ ] **Step 3:** Commit `feat: packaging and logon task scripts`. Registering the task on the Studio PC (`-Apply`) is done there, by Yann, not during this plan.

---

## Self-review (against the spec)

- Spec section 3 (profiles) -> Tasks 5, 9; section 4 (mod comparison) -> Tasks 10-14, 16; section 5 (cascade) -> Task 15 (signals 1, 3, 5 now; others in the boot-test and build phases); section 7 workflow steps Loader check, Mods, Sides -> Tasks 13-17; section 9 (storage) -> Tasks 5, 6, 12; section 10 (stack) -> Tasks 1-8, 18; section 13 (security) -> Tasks 2, 4, 8; invariants 1, 6, 8, 10 are asserted in Tasks 2, 9, 12-14, 6; invariants 2-5, 7, 9 belong to the deploy and config phases.
- Not in this plan on purpose (each gets its own plan): config engine, harvest, customization memory, builds, boot test, deploy agent, publishing, assistant, other loaders.
- Names are consistent across tasks: `ModSet`/`ModEntry` (14), `JarInfo`/`ModDecl` (11), `ZipHandle` (4), `JobContext` (7), `LoaderInfo` (13), `Side` (15).
