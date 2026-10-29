# Update packs

[← README](../README.md)

## The plan

On the Mods tab each row that can take the reference jar has a toggle: **update** (older, different, rebuilt) or **put the mod back** (missing). Config files are chosen in the Configs tab ([Config analysis](configs-analysis.md)). The plan is stored per comparison (`PUT /plan`, table `update_plan_item`, kinds mod / file). **Ticking a row writes nothing anywhere.** Pins, accepted removals and client-only decisions appear as badges.

## Export

**Prepare the update pack** (`POST /plan/export`, job `export-update-pack`) writes under `data/exports/update-<other>-from-<base>-<UTC stamp>/`:

| Path | Content |
|---|---|
| `mods-add/` | Reference jars, re-hashed and checked against the sha256 recorded at import (a mismatch or missing jar is reported, not copied) |
| `remove.txt` | The compared profile's current jar of every planned update |
| `files-add/` | Planned config files, copied from the reference or, for customizations, from the played profile |
| `changes.json`, `CHANGES.md`, `result.json` | Machine and human readable change list |
| `apply.ps1` | Safe applier |
| `<name>.zip` | The same folder zipped, next to it |

Jars need not be imported when the plan contains only files.

## Applying

```powershell
.\apply.ps1 -InstanceDir "D:\Instances\MyPack"          # dry run: checks every sha256, prints the changes
.\apply.ps1 -InstanceDir "D:\Instances\MyPack" -Apply   # moves replaced/removed files to _studio-backup-<stamp>\, then copies
```

The script refuses to run while a `java`/`javaw` process uses the instance (unless `-Force`) and **never deletes a file**: replaced and removed files are moved into a timestamped backup folder. Works in Windows PowerShell 5.1 and PowerShell 7.

Studio itself never writes into an instance. See [Security](security.md).
