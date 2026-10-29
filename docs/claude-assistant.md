# Claude assistant

[← README](../README.md) · [Settings](settings.md)

Studio can ask Claude to review the lists it produces. Two modes, chosen per click:

| Mode | How it works | Good for |
|---|---|---|
| **api** | Studio calls the Claude API through the official SDK and shows the answer | One click, no copy-paste. The API has no internet access |
| **chat** | Studio builds the prompt and you paste it into claude.ai | Questions that need web search (mod changelogs, compatibility) |

## Actions

| Action | Question it answers |
|---|---|
| `review-updates` | Are these mod updates worth applying? Anything risky? |
| `review-added` | Are the mods I added useful, redundant or abandoned? |
| `review-missing` | Why might these base mods be missing from my pack? |
| `migrate-old-pack` | What from my old pack is missing in the new base, and what replaces it? |
| `analyze-test-run` | Why did this server test fail, or what warns in its log? |

Buttons appear on the Mods, Old pack and Test bench tabs. Prompts are built from Studio's data (`src/server/assistant/prompts.ts`: `buildPrompt`, `buildTestRunPrompt`) and **are not stored**. Pack names in prompts come from the two pack-name settings.

## Behaviour

- Default model `claude-sonnet-5-5`, effort `medium`; both selectable in Settings.
- The SDK sends the key as `Authorization: Bearer`; the API version is chosen by the SDK.
- A refusal is reported with the code `refused`, never retried silently. No fallback model is enabled.
- Keys are stored write-only ([Settings](settings.md)), never logged, never audited.

Source: `src/server/assistant/anthropic.ts` (client factory, `runPrompt`, `checkClaudeKey`), `routes-assistant.ts` (`GET /assistant/actions`, `POST /assistant/prompt`, `POST /assistant/run`).
