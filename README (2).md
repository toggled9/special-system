# Showrunner

A hidden narrative-director layer for SillyTavern / TauriTavern (pure frontend
extension). An out-of-band "showrunner" LLM pass maintains a structured plot
plan (acts, beats, threads, secrets, canon) and injects only a short directive
into each writer prompt. The plan itself never enters the story context.

## Why

Long SillyTavern chats drift once the context bloats: no plot planning, twists
that come out of nowhere, retcons. Showrunner fixes this by compartmentalizing:

- A **director pass** (`generateRaw`, bypasses your chat preset) re-plans every
  N messages from the recent turns and its own JSON state.
- Only a **<= 300 token directive** rides into the writer prompt, injected
  in-chat at depth 4 as a system message via `setExtensionPrompt`.
- **Secrets** stay out of the writer context until their reveal beat; the writer
  only sees the seeds it must plant.

### Escalation layer

The directive is deliberately binding, not advisory. It carries:

- `BINDING BEAT n` — this scene's beat. VAD/instincts in the preset decide *how*
  NPCs carry it out, not *what* happens.
- `Clocks:` — up to 3 countdowns (`▮▮▮▯▯▯ n/6 | fills when | on fill`). A clock is
  an irreversible event, not ambience.
- `Must leave behind:` — the one irreversible change the scene owes the story.
- `Pressure`, `Player wants`, capped `Canon`, and imminent `Do NOT reveal yet`.

Every list is capped (canon 6, clocks 3, withheld secrets 2 within 2 beats) so the
injected size stays flat as a chat grows.

## Install

TauriTavern (Android/desktop) — extension installer accepts anonymous https git
remotes only (public repos, no `/tree/` web URLs):

1. Push these files to the **root** of a public GitHub repo.
2. TT extensions panel -> Install extension -> `https://github.com/<you>/<repo>.git`.
3. Enable the extension, reload.

Desktop SillyTavern — copy this folder into
`data/default-user/extensions/` (or `data/extensions/third-party/` for global)
and restart.

TT LAN/TT-Sync: the `extensions.local` / `extensions.third_party` sync datasets
carry installed extensions between paired devices.

## Usage

1. Open the chat with your character card.
2. Extensions settings -> Showrunner -> write premise notes -> **Cold start**
   (or `/showrunner-cold`). This builds the three-act plan and the first
   directive before the story starts.
3. Play normally. Every `cadence` messages the showrunner reconciles the plan
   with the recent turns (turns win on conflict) and refreshes the directive.
4. **Peek at plan** shows the hidden state for debugging; **Clear state**
   resets the chat's plan (premise notes survive).

The showrunner calls run with their own system prompt through `generateRaw`,
so the Frankenstein preset (or any chat preset) is untouched. Best paired with
a strong reasoning model; any model that emits valid JSON works. If JSON
parsing fails it retries once, else keeps the previous plan.

The director reads the recent turns with `<!-- GFX_START -->`, `<internal_states>`,
`<!-- IMG_PROMPT -->`, and fenced code blocks stripped out, so it sees prose
rather than its own HTML and the director prompt stays cheap.

On upgrade the saved system prompt is refreshed automatically when it is the
shipped one (recognised by its opening line and missing `"clocks"`); a prompt you
wrote yourself is never overwritten. The `Recent turns` default moved 10 -> 20.

## Tuning

| Setting | Default | Notes |
| --- | --- | --- |
| Cadence | 6 | messages between automatic re-plans; raise for cheaper runs |
| Injection depth | 4 | where the directive sits in the writer context |
| Recent turns | 20 | how much verbatim history the director reviews (was 10) |

## API surface used (verified against TauriTavern `main`)

- `setExtensionPrompt(key, value, position, depth, scan, role)` — from `script.js`
- `generateRaw({ prompt, systemPrompt })` — from `script.js`
- `saveMetadataDebounced` — from `scripts/extensions.js` (TT split; not in `script.js`)
- `extension_prompt_types` / `extension_prompt_roles` — from `scripts/extension-prompts.js` (TT split)
- `event_types.GENERATION_ENDED` / `CHAT_CHANGED` / `APP_READY` — from `script.js`
- `chat_metadata` for per-chat plan state, `extension_settings` for global
- Import depths: `../../../../script.js`, `../../../extensions.js`,
  `../../../extension-prompts.js`, `../../../power-user.js`, `../../../popup.js`,
  `../../../slash-commands/SlashCommandParser.js`

Note: upstream SillyTavern still exports `saveMetadataDebounced` and the
extension-prompt enums from `script.js`; TauriTavern moved them. If you port
this back to upstream ST, merge those two import lines into the `script.js`
import and drop `extension-prompts.js`.

## Known limits

- Not tested against a live TauriTavern build; if the drawer never appears,
  check the browser console for import errors (API drift between upstream
  versions is the usual cause).
- One connection profile: the director uses the same model/API as the chat.
  Splitting director/writer models is a possible v0.2.
- Plan state lives in `chat_metadata` — it syncs with the chat, but is not
  visible in the message list.
- Beat-distance maths for withheld secrets assumes ids like `1.2` or `3`.
  Unparseable ids fall back to always guarding the secret.