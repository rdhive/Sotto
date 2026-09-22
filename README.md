# Sotto

Local push-to-talk dictation for Windows 10/11. Hold a key, speak, and the
polished text lands wherever your cursor is — in any app.

Everything runs on this machine. No API keys, no subscription, no audio
leaving the box.

## Shape

Two processes with a hard boundary between them.

```
┌─ engine (Python) ───────────────────────────────────────────┐
│  WH_KEYBOARD_LL hook · always-open WASAPI ring buffer        │
│  faster-whisper on CUDA · local LLM cleanup · clipboard+V    │
└───────────────────────┬─────────────────────────────────────┘
                        │  newline-delimited JSON, 127.0.0.1:8765
┌───────────────────────┴─────────────────────────────────────┐
│─ app (Electron) ────────────────────────────────────────────│
│  main    dictionary + correction pass, history, hotkey,      │
│          windows, tray. All disk and network access.         │
│  render  transcriptions, dictionary, meters. No Node.        │
└──────────────────────────────────────────────────────────────┘
```

The engine has no dependency on the app — dictation keeps working with the
window closed. The app reconnects on its own whenever the engine restarts.

The renderer runs with `contextIsolation` on and `nodeIntegration` off. Its
entire capability surface is the named calls in `electron/preload.js`.

## Layout

```
core/sotto/          the engine
  hotkey.py          low-level keyboard hook, own message pump
  audio.py           always-open capture, ring buffer, resampling
  stt.py             faster-whisper (CTranslate2) on CUDA
  polish.py          local LLM cleanup, rules fallback
  inject.py          clipboard + SendInput
  ipc.py             loopback transport, exclusive port bind
  engine.py          state machine
shell/
  electron/
    main.js          windows, menu, tray, global shortcut, IPC
    dictionary.js    store + correction engine
    core-client.js   engine transport
    history.js       transcription history
    window-state.js  geometry persistence
  renderer/
    tokens.css       the design system — every value in the UI
    fonts.css        bundled Archivo / DSEG7 / JetBrains Mono
    index.html       main window
    settings.html    settings window
```

## Install

Engine, once:

```
py -3.11 -m venv .venv
.venv\Scripts\pip install -r core\requirements.txt
ollama pull qwen2.5:3b-instruct
```

App:

```
cd shell
npm install
npm run dist
```

The installer lands in `dist\`. Run it, then pin Sotto from the Start menu.

## Run

The engine is a background service and must be running:

```
sotto.bat
```

Then launch Sotto from the Start menu. Only one engine can run at a time —
a second one exits with a message rather than silently stacking.

## The dictionary

Teach it names and jargon it keeps getting wrong. Two entry types:

- **Word or phrase** — "Anthropic", "Supabase". Feeds the bias list.
- **Correction pair** — when you hear *X*, write *Y*. Feeds both.

Both mechanisms run, because one alone is not enough.

**Biasing** hands your terms to Whisper as context so it leans toward
producing them. It is a nudge, not a promise, and the list is capped at 40
terms / 320 characters — a long prompt makes Whisper drift and invent text
on quiet audio.

**The correction pass** is the guarantee. Whole-word, case-insensitive,
longest match first, applied in the main process before the engine injects.

Multi-word entries match glued and hyphenated forms, because speech models
produce those unpredictably. `cloud code` compiles to
`\bcloud[\s-]*code\b`, which catches *cloud code*, *CloudCode* and
*Cloud-Code* — and cannot touch *Cloudflare*, the bare word *cloud*, or
*cloud coder*. Entries that would rewrite ordinary speech get a warning
before you save them.

The file is plain JSON at `%APPDATA%\Sotto\dictionary.json`, editable by
hand. The app watches it and reloads on change, and every write re-reads
from disk first, so a hand edit is never clobbered by a stale in-memory
copy.

Run the correction tests with:

```
cd shell && npm test
```

## Design

`renderer/tokens.css` is the whole design system — colour, type scale,
spacing, radius, border, shadow, motion. Components pull from it; no
literal values in views. Fixed appearance: the app does not follow the
Windows light/dark theme.

Fonts are bundled (80 KB total), so nothing is fetched at runtime and the
look does not shift with system font settings.

## Notes

**The Fn key cannot be bound.** It is handled in keyboard firmware and
never reaches Windows. Compact boards often drop Right Ctrl too — Caps
Lock is the best default, and F13–F24 from a Stream Deck or programmable
keyboard is better still. Avoid Right Alt on a Belgian/French layout: it
is AltGr, and binding it costs you `@`, `#`, `€`, `[` and `]`.

**Two different hotkeys.** Push-to-talk is held and belongs to the engine's
keyboard hook. The global toggle is a normal accelerator registered with
Windows through `globalShortcut`; if another application already owns the
combination, the status bar says so.

**Clipboard.** Paste injection stashes and restores `CF_UNICODETEXT`. Other
formats on the clipboard at dictation time are lost. Set `inject_method`
to `"type"` to avoid the clipboard entirely, at the cost of speed.

**CUDA libraries.** `nvidia-cublas-cu12` and `nvidia-cudnn-cu12` unpack
into `site-packages/nvidia/*/bin`, which Windows does not search.
`stt.register_cuda_dlls()` puts them on the search path; without it
CTranslate2 loads fine and then fails on the first GPU call.
