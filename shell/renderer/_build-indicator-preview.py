"""Static specimen sheet for the recording indicator.

The shipped indicator.css is used verbatim; only the ladder segments are
pre-lit here, because in the product they are painted by requestAnimationFrame
and a static snapshot would show them all dark.
"""
import base64
import re
from pathlib import Path

HERE = Path(__file__).parent
N = 20

GREEN, AMBER, RED, OFF = "#7d9e4e", "#d29b38", "#c0392b", "#1e211b"


def seg_colour(i: int) -> str:
    v = i / (N - 1)
    if v > 0.85:
        return RED
    if v > 0.70:
        return AMBER
    return GREEN


def ladder(level: float, peak: float | None = None, dim: bool = False) -> str:
    lit = round(level * N)
    peak_seg = round((peak if peak is not None else level) * N)
    out = []
    for i in range(N):
        on = (i < lit or i == peak_seg - 1) and not dim
        c = seg_colour(i)
        style = (
            f"background:{c};box-shadow:0 0 3px {c}, inset 0 1px 1px rgba(0,0,0,.3)"
            if on else
            f"background:{OFF};box-shadow:inset 0 1px 1px rgba(0,0,0,.7)"
        )
        out.append(f'<i style="{style}"></i>')
    return "".join(out)


def unit(state: str, label: str, level: float, counter: str,
         peak: float | None = None) -> str:
    dim = state == "working"
    return f"""
<div class="unit visible" data-state="{state}">
  <div class="section">
    <span class="lamp"></span>
    <span id="label">{label}</span>
  </div>
  <div class="seam"></div>
  <div class="section"><div class="ladder">{ladder(level, peak, dim)}</div></div>
  <div class="seam"></div>
  <div class="section">
    <div class="readout">
      <span class="ghost">88:88</span>
      <span class="live">{counter}</span>
    </div>
  </div>
</div>"""


def inline_fonts() -> str:
    css = (HERE / "fonts.css").read_text(encoding="utf-8")

    def embed(m: re.Match) -> str:
        data = (HERE / m.group(1)).resolve().read_bytes()
        return 'src: url("data:font/woff2;base64,%s") format("woff2")' % (
            base64.b64encode(data).decode()
        )

    return re.sub(r'src: url\("([^"]+)"\) format\("woff2"\)', embed, css)


ROWS = [
    ("recording", "Rec", 0.62, "00:07", 0.80),
    ("recording", "Rec", 0.18, "00:23", 0.34),
    ("working", "Working", 0.0, "00:23", None),
    ("working", "Inserting", 0.0, "00:23", None),
]


def main() -> None:
    scaled = "".join(
        f'<div class="row"><span class="tag">{lbl.lower()}</span>'
        f'<div class="mag">{unit(st, lbl, lv, ct, pk)}</div></div>'
        for st, lbl, lv, ct, pk in ROWS
    )

    page = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Indicator</title>
<style>
{inline_fonts()}
{(HERE / "tokens.css").read_text(encoding="utf-8")}
{(HERE / "indicator.css").read_text(encoding="utf-8")}
html, body {{ height:auto; background:#37383a; display:block; padding:0; }}
.sheet {{ padding:26px 30px 34px; }}
.caption {{
  font:600 10px/1.7 var(--font-legend); text-transform:uppercase;
  letter-spacing:var(--track-legend); color:#8e8b83; margin:22px 0 10px;
}}
.actual {{ display:flex; gap:34px; align-items:center; flex-wrap:wrap; }}
.on-light {{ background:#d7d4cc; padding:16px 20px; border-radius:3px; }}
.row {{ display:flex; align-items:center; gap:18px; margin-bottom:16px; }}
.tag {{
  width:74px; flex:none; text-align:right;
  font:500 9px/1.6 var(--font-legend); text-transform:uppercase;
  letter-spacing:var(--track-legend); color:#7d7a73;
}}
.mag {{ transform:scale(2.4); transform-origin:left center; height:34px; }}
.mag + * {{ margin-left:0; }}
.row {{ height:86px; }}
</style></head>
<body><div class="sheet">

  <div class="caption">Actual size &mdash; 290 &times; 34</div>
  <div class="actual">
    {unit("recording", "Rec", 0.62, "00:07", 0.80)}
    <div class="on-light">{unit("recording", "Rec", 0.62, "00:07", 0.80)}</div>
  </div>

  <div class="caption">Magnified 2.4&times;</div>
  {scaled}

</div></body></html>"""

    out = HERE / "_indicator-preview.built.html"
    out.write_text(page, encoding="utf-8")
    print("built %s (%.0f KB)" % (out.name, len(page) / 1024))


if __name__ == "__main__":
    main()
