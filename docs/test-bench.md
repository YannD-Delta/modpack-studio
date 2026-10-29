# Test bench

[← README](../README.md)

Starts a **throwaway copy** of a server, waits for it to finish loading, stops it and keeps the logs. Your real server is never touched.

## Run

`POST /testbench/server` (job), `GET /testbench/runs[/:id[/log]]`, `POST /testbench/runs/:id/cancel`. One test at a time.

1. **Copy** the server folder without the world (`level-name` is read from `server.properties`). Skipped: `logs`, `crash-reports`, `backups`, `dynmap`, `sdlinkstorage`.
2. **Adapt the copy** (never the source):
   - port `25570` by default, `online-mode=false`, RCON off;
   - `user_jvm_args.txt` memory rewritten (no `AlwaysPreTouch`);
   - jars matching `/discord|dcintegration|dynmap|bluemap/i` renamed `.jar.disabled`, so a test never posts to a real channel.
3. **EULA** is accepted in the copy only if you tick the checkbox or the source already accepted it.
4. **Start** through `run.bat` / `startserver.bat` / `start.bat`, then wait for `Done (x s)!`.
5. **Stop**: send `stop`, then kill the process tree if it does not exit.
6. **Keep** `result.json`, `status.json`, `meta.json` and `console.log` in `data/tests/<stamp>_<pack>-<version>-<state>/`.

## Analysis

The **Analyse with Claude** button builds a prompt from the run (result, crash report, log tail) and answers in plain language, through the API or as a prompt to paste ([Claude assistant](claude-assistant.md)).

## Not yet

A **client** test needs a launcher and a Minecraft account, which are not part of Studio. Options (offline accounts, headless launchers) are still a spike; see the [roadmap](roadmap.md).
