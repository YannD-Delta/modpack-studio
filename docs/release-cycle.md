# Release cycle

> Part of [Modpack Studio](../README.md) · created with Claude Code · [Roadmap](roadmap.md)

**What this page covers:** the target workflow when the base modpack publishes a new version, and which steps Studio supports today.

<p align="center"><img src="assets/release-cycle.svg" alt="Animated overview of the release cycle: extract the base twice, build the candidate, test it, validate, copy clean to launched, publish, update the played copies, announce" width="900"></p>

The flowchart below shows the cycle. Blue steps exist today (fully or in part), amber steps are done by you outside Studio, grey steps are planned.

```mermaid
flowchart TD
  A["Base modpack update detected"] --> B["Extract the new base twice<br/>(two folders)"]
  B --> C["clean: never started"]
  B --> D["launched: started once"]
  C --> E["Candidate = base clean<br/>+ your mods + replayed config changes<br/>+ updated own mods"]
  D --> E
  E --> F["Temporary server and client tests"]
  F --> G{"Valid?"}
  G -- no --> E
  G -- yes --> H["Push to your clean<br/>+ CurseForge zips + server pack"]
  H --> I["Copy clean to launched<br/>(start the copy once)"]
  I --> J["Publish on CurseForge,<br/>wait for approval"]
  J --> K["Update the played<br/>server and client"]
  K --> L["Announce on Discord"]
  classDef done fill:#7fb3e6,stroke:#1f4e79,color:#101010
  classDef manual fill:#f0c674,stroke:#8a6d1a,color:#101010
  classDef planned fill:#c4c9d0,stroke:#5a616b,color:#101010
  class B,C,D,E,F,H done
  class G,I,J,K manual
  class A,L planned
```

## Steps

1. **Detect** a new base version (planned).
2. **Extract the base twice.** The *clean* copy is never started. Only the second copy is started once to become *launched* ([Concepts](concepts.md)). Studio imports both as profiles; the extraction itself is done by you.
3. **Build the candidate**: base clean + your mods + your config changes replayed ([Config analysis](configs-analysis.md)) + your own mods updated ([Mod analysis](mods-analysis.md)). The comparisons and the update plan exist today; an automated build is planned.
4. **Test** on throwaway copies: server today ([Test bench](test-bench.md)), client planned.
5. **Validate** (you decide), then push the result to your clean profile and produce the CurseForge zips and the server pack. Update packs exist today ([Update packs](update-pack.md)); the full CurseForge zips and the server pack builder are planned.
6. **Copy clean to launched** and start the copy once, so the reference pair for the next cycle exists. Done by you.
7. **Publish** on CurseForge and wait for the approval. Done by you.
8. **Update the played copies**: the server (through your panel) and the client (through the CurseForge app). Done by you.
9. **Announce** on Discord: the changelog comes from CurseForge plus your own changes, sent through a webhook entered in Settings. The server's Discord mod keeps its token encrypted and its webhooks empty, so Studio needs its own webhook (planned).

Nothing here pushes, publishes or posts by itself: each outward step waits for your explicit action.
