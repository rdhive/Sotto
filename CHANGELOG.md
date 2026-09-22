# Changelog

All notable changes to Sotto. Versions follow [Semantic Versioning](https://semver.org).

## [0.2.0] - 2026-09-22

A complete visual redesign. Dictation, the engine and your data are unchanged.

### Changed
- New look based on Apple's product language: neutral surfaces, grouped
  cards, one blue accent, and red only while Sotto is capturing your voice.
- Follows the Windows light and dark setting, including the title bar
  buttons, and switches live when the setting changes.
- Recorder: one record/stop button replaces the separate Record and Stop
  keys. A live scrolling waveform and a large timer replace the VU meter and
  LED ladder, and the last take stays visible after you stop.
- Transcriptions are grouped by day (Today, Yesterday, then dates).
  Dictionary fixes appear inline as `cloud code → Claude Code`.
- Dictionary editor and entry list rebuilt as cards; editing shows a clear
  *Edit entry* state and saves with Enter.
- Settings grouped into Shortcuts, Recognition and Application, with real
  switches and shortcuts shown as keycaps.
- The floating recording indicator is now a dark pill with a pulsing dot, a
  mini waveform and the elapsed time. It turns amber while transcribing.
- The UI uses the Windows system font. Only JetBrains Mono is bundled now.

### Added
- Settings button in the main window title bar.
- Ctrl + F focuses search. Esc cancels a dictionary edit.
- Empty search results say so instead of showing an empty list.

### Fixed
- White text on blue buttons meets WCAG AA contrast in dark mode.

## [0.1.0]

First release.

- Push-to-talk and toggle dictation into any Windows application.
- faster-whisper speech recognition on CUDA, with local LLM or rules cleanup.
- Dictionary with recognition biasing and a guaranteed correction pass.
- Transcription history, settings window, tray icon and start with Windows.
- Floating recording indicator.

[0.2.0]: https://github.com/rdhive/Sotto/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rdhive/Sotto/releases/tag/v0.1.0
