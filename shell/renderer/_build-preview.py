"""Regenerate the self-contained token proving sheet.

_tokens-preview.html is the source and links tokens.css/fonts.css normally.
This inlines both, and base64-embeds the woff2 files, so the sheet renders
standalone in a viewer that serves it as a data URL.
"""
import base64
import re
from pathlib import Path

HERE = Path(__file__).parent


def main() -> None:
    fonts = (HERE / "fonts.css").read_text(encoding="utf-8")

    def embed(m: re.Match) -> str:
        data = (HERE / m.group(1)).resolve().read_bytes()
        return 'src: url("data:font/woff2;base64,%s") format("woff2")' % (
            base64.b64encode(data).decode()
        )

    fonts = re.sub(r'src: url\("([^"]+)"\) format\("woff2"\)', embed, fonts)
    tokens = (HERE / "tokens.css").read_text(encoding="utf-8")

    src = (HERE / "_tokens-preview.html").read_text(encoding="utf-8")
    out = src.replace(
        '<link rel="stylesheet" href="fonts.css">\n'
        '<link rel="stylesheet" href="tokens.css">',
        "<style>\n%s\n%s\n</style>" % (fonts, tokens),
    )
    dest = HERE / "_tokens-preview.built.html"
    dest.write_text(out, encoding="utf-8")
    print("built %s (%.0f KB)" % (dest.name, len(out) / 1024))


if __name__ == "__main__":
    main()
