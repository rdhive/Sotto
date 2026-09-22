"""Entry point: python -m sotto"""
from __future__ import annotations

import argparse
import logging
import sys

from . import log
from .config import CONFIG_PATH, Config


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sotto", description=__doc__)
    parser.add_argument(
        "--list-devices", action="store_true", help="list input devices and exit"
    )
    parser.add_argument(
        "--list-keys", action="store_true", help="list bindable hotkeys and exit"
    )
    parser.add_argument(
        "--set-key",
        action="store_true",
        help="press a key to bind it as the push-to-talk key, then exit",
    )
    parser.add_argument(
        "--set",
        nargs="+",
        metavar="KEY=VALUE",
        help='set config values, e.g. --set language=fr beam_size=5',
    )
    parser.add_argument(
        "--config", action="store_true", help="print the config file path and exit"
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    log.setup(logging.DEBUG if args.verbose else logging.INFO)

    if args.set:
        import json
        from dataclasses import fields

        cfg = Config.load()
        known = {f.name for f in fields(Config)}
        for pair in args.set:
            if "=" not in pair:
                print("Expected KEY=VALUE, got %r" % pair)
                return 1
            key, _, value = pair.partition("=")
            key = key.strip()
            if key not in known:
                print("Unknown setting %r. Run --config to see them all." % key)
                return 1
            # JSON first so numbers, booleans and null keep their types;
            # anything else is a plain string (device names, model ids).
            try:
                parsed = json.loads(value)
            except json.JSONDecodeError:
                parsed = value
            setattr(cfg, key, parsed)
            print("  %s = %r" % (key, parsed))
        cfg.save()
        print("Saved to %s" % CONFIG_PATH)
        return 0

    if args.config:
        from .hotkey import key_name

        cfg = Config.load()
        print("")
        print("  file      %s" % CONFIG_PATH)
        print("  hotkey    %s (0x%02X)" % (key_name(cfg.hotkey_vk), cfg.hotkey_vk))
        print("  mic       %s" % (cfg.input_device or "system default"))
        print("  model     %s on %s" % (cfg.stt_model, cfg.stt_device))
        print("  language  %s" % (cfg.language or "auto-detect"))
        print("  cleanup   %s (%s)" % (cfg.polish_backend, cfg.polish_model))
        print("  insert    %s" % cfg.inject_method)
        print("")
        return 0

    if args.list_keys:
        from .hotkey import VK_NAMES

        for vk, name in sorted(VK_NAMES.items()):
            print("  0x%02X  %s" % (vk, name))
        print("")
        print("Note: the Fn key is handled in keyboard firmware and never")
        print("reaches Windows, so it cannot be bound.")
        return 0

    if args.set_key:
        from .hotkey import capture_next_key, key_name

        print("")
        print("Press and hold the key you want to dictate with, then let go.")
        print("(Esc to cancel. Modifier keys are fine - press the modifier")
        print(" itself, not a combination.)")
        print("")
        vk = capture_next_key()
        if vk is None:
            print("Cancelled, nothing changed.")
            return 1

        from .hotkey import is_typing_key

        if is_typing_key(vk):
            # Suppression is what stops the key reaching the focused app.
            # On a character key that means losing the character entirely.
            print("")
            print("  Careful: %s is a character you type." % key_name(vk))
            print("  Binding it means you can no longer type that character")
            print("  anywhere, because Sotto swallows the keypress.")
            print("")
            print("  Better options: Caps Lock, Menu, Scroll Lock, or")
            print("  F13-F24 from a Stream Deck or programmable keyboard.")
            print("")
            if input("  Bind it anyway? [y/N] ").strip().lower() not in ("y", "yes"):
                print("Cancelled, nothing changed.")
                return 1

        cfg = Config.load()
        cfg.hotkey_vk = vk
        cfg.save()
        print("Bound to %s (0x%02X)." % (key_name(vk), vk))
        print("Saved to %s" % CONFIG_PATH)
        return 0

    if args.list_devices:
        from .audio import list_devices

        for dev in list_devices():
            print(
                "  [%2d] %s  (%s, %dch)"
                % (dev["index"], dev["name"], dev["hostapi"], dev["channels"])
            )
        return 0

    cfg = Config.load()
    from .engine import Engine

    try:
        Engine(cfg).run()
    except RuntimeError as exc:
        # Most likely a second instance. A stack trace helps nobody here.
        log.get("sotto").error("%s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
