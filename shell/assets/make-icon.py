"""Generate assets/icon.ico from the design tokens.

Kept as a script rather than a checked-in binary so the mark stays tied to
the palette: if a chassis token changes, regenerate instead of redrawing.
"""
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).parent

CHASSIS = (26, 25, 23, 255)      # --c-chassis-800
BEVEL = (92, 90, 82, 255)        # --c-alum-600
BONE = (231, 226, 212, 255)      # --c-bone-100
RECORD = (224, 80, 63, 255)      # --c-record-lit

SIZES = [16, 24, 32, 48, 64, 128, 256]
S = 1024  # draw large, downsample — keeps the curves clean at 16px


def draw_master() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Chassis: a machined slab, not a rounded app blob.
    pad = S * 0.045
    d.rounded_rectangle([pad, pad, S - pad, S - pad],
                        radius=S * 0.14, fill=CHASSIS, outline=BEVEL,
                        width=int(S * 0.012))

    # Microphone capsule.
    cw, ch = S * 0.20, S * 0.34
    cx, top = S / 2, S * 0.20
    d.rounded_rectangle([cx - cw / 2, top, cx + cw / 2, top + ch],
                        radius=cw / 2, fill=BONE)

    # Pickup arc.
    r = S * 0.20
    cy = top + ch - r * 0.32
    d.arc([cx - r, cy - r, cx + r, cy + r], start=0, end=180,
          fill=BONE, width=int(S * 0.045))

    # Stem.
    d.rounded_rectangle([cx - S * 0.022, cy + r, cx + S * 0.022, cy + r + S * 0.11],
                        radius=S * 0.022, fill=BONE)

    # Record lamp — the single accent.
    lr = S * 0.055
    lx, ly = S * 0.755, S * 0.245
    d.ellipse([lx - lr, ly - lr, lx + lr, ly + lr], fill=RECORD)

    return img


# --- tray icons -----------------------------------------------------------
# Electron's nativeImage cannot read SVG. A tray built from an SVG data URL
# produces an empty image and an invisible icon, with no error — so these
# are real bitmaps, generated here from the same palette.

TRAY_IDLE = (181, 178, 166, 255)   # --c-alum-300
TRAY_REC = (224, 80, 63, 255)      # --c-record-lit
TRAY_SIZES = [16, 20, 24, 32, 48]


def draw_tray(colour) -> Image.Image:
    """A bold mic silhouette. At 16px there is no room for detail, so the
    strokes are heavier than the app icon's."""
    s = 512
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    cw, ch = s * 0.30, s * 0.46
    cx, top = s / 2, s * 0.10
    d.rounded_rectangle([cx - cw / 2, top, cx + cw / 2, top + ch],
                        radius=cw / 2, fill=colour)

    r = s * 0.30
    cy = top + ch - r * 0.30
    d.arc([cx - r, cy - r, cx + r, cy + r], start=0, end=180,
          fill=colour, width=int(s * 0.085))

    d.rounded_rectangle([cx - s * 0.042, cy + r - s * 0.02,
                         cx + s * 0.042, cy + r + s * 0.16],
                        radius=s * 0.042, fill=colour)
    return img


def write_tray() -> None:
    for name, colour in (("tray-idle", TRAY_IDLE), ("tray-rec", TRAY_REC)):
        master = draw_tray(colour)
        frames = [master.resize((n, n), Image.LANCZOS) for n in TRAY_SIZES]
        out = HERE / f"{name}.ico"
        frames[-1].save(out, format="ICO",
                        sizes=[(n, n) for n in TRAY_SIZES],
                        append_images=frames[:-1])
        print("wrote %s" % out.name)


def main() -> None:
    master = draw_master()
    frames = [master.resize((n, n), Image.LANCZOS) for n in SIZES]
    out = HERE / "icon.ico"
    frames[-1].save(out, format="ICO",
                    sizes=[(n, n) for n in SIZES], append_images=frames[:-1])
    master.resize((512, 512), Image.LANCZOS).save(HERE / "icon.png")
    print("wrote %s (%d sizes) and icon.png" % (out.name, len(SIZES)))
    write_tray()


if __name__ == "__main__":
    main()
