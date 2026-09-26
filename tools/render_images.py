import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT.parent / "ClipManager" / "icons"
OUT = ROOT / "com.ijuantm.clipmanager.sdPlugin" / "imgs"

# Icon metrics and colours mirror the popup renderer in clip_manager.py so keys and toasts look alike.
ICON_CANVAS = 512
ICON_CONTENT_REF = 410
SELF_CONTAINED_ICON_SCALE = 2.0
GLYPH_ICON_SCALE = 1.1
ICON_Y_OFFSET_SRC_PX = {"display-capture-on": 12.5, "display-capture-off": 12.5}
BG_TOP, BG_BOTTOM = (40, 40, 43), (20, 20, 22)
BLUE = (59, 130, 246)
GREY = (107, 114, 128)
DARK = (55, 55, 60)
AMBER = (185, 129, 16)
TEXT_ON = (255, 255, 255)
TEXT_OFF = (170, 170, 178)
TEXT_DIM = (120, 120, 126)
FONT = r"C:\Windows\Fonts\segoeuib.ttf"

KEY = 144
SS = 4
SPINNER_FRAMES = 12
# Must cover every size in plugin.js KEY_PX, or those keys get no image.
DEVICE_KEY_SIZES = (72, 80, 96, 120, 144)
MANIFEST_DEFAULTS = {"game-off", "display-off", "mic-off", "listen-off", "save-inactive"}


def round_px(x):
    return math.floor(x + 0.5)


def background(size):
    img = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        color = tuple(round_px(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))
        draw.line([(0, y), (size, y)], fill=color + (255,))
    return img


def paste_icon(base, name, cx, cy, diameter, alpha):
    icon = Image.open(ICONS / f"{name}.png").convert("RGBA")
    scale = diameter / ICON_CONTENT_REF
    size = round_px(ICON_CANVAS * scale)
    icon = icon.resize((size, size), Image.LANCZOS)
    if alpha < 1:
        icon.putalpha(icon.getchannel("A").point(lambda a: round_px(a * alpha)))
    dy = round_px(ICON_Y_OFFSET_SRC_PX.get(name, 0) * scale) - SS
    base.alpha_composite(icon, dest=(round_px(cx - size / 2), round_px(cy - size / 2) - dy))


def fitted_font(draw, text, max_w, size):
    while True:
        font = ImageFont.truetype(FONT, size)
        box = draw.textbbox((0, 0), text, font=font)
        if box[2] - box[0] <= max_w or size <= 10 * SS:
            return font
        size -= SS // 2


def render_key(
    icon,
    label,
    badge=None,
    label_color=TEXT_ON,
    glyph_alpha=1.0,
    pressed=False,
    spinner=None,
):
    size = KEY * SS
    img = background(size)
    draw = ImageDraw.Draw(img)
    cx, cy = size / 2, 56 * SS
    r = 36 * SS * (0.88 if pressed else 1.0)

    if spinner is not None:
        ring_r = 36 * SS + 7 * SS
        box = (cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r)
        draw.ellipse(box, outline=(60, 60, 66), width=4 * SS)
        start = spinner * 360 / SPINNER_FRAMES - 90
        draw.arc(box, start, start + 110, fill=BLUE, width=4 * SS)
    if pressed:
        ring_r = 36 * SS + 4 * SS
        draw.ellipse(
            (cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r),
            outline=(235, 235, 240),
            width=3 * SS,
        )

    if badge:
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=badge)
        paste_icon(img, icon, cx, cy, GLYPH_ICON_SCALE * r, glyph_alpha)
    else:
        paste_icon(img, icon, cx, cy, SELF_CONTAINED_ICON_SCALE * r, glyph_alpha)

    font = fitted_font(draw, label, 134 * SS, 22 * SS)
    box = draw.textbbox((0, 0), label, font=font)
    ref = draw.textbbox((0, 0), "Ag", font=font)
    draw.text(
        (cx - (box[0] + box[2]) / 2, 121 * SS - (ref[1] + ref[3]) / 2),
        label,
        font=font,
        fill=label_color,
    )
    return img


def save(img, rel):
    folder, name = rel.split("/")
    for px in DEVICE_KEY_SIZES:
        path = OUT / folder / str(px) / f"{name}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        img.resize((px, px), Image.LANCZOS).save(path)
    if name in MANIFEST_DEFAULTS:
        img.resize((KEY, KEY), Image.LANCZOS).save(OUT / folder / f"{name}@2x.png")
        img.resize((KEY // 2, KEY // 2), Image.LANCZOS).save(OUT / folder / f"{name}.png")


def save_with_pressed(rel, **kwargs):
    save(render_key(**kwargs), rel)
    save(render_key(pressed=True, **kwargs), rel + "-pressed")


TOGGLES = {
    # action: (on icon, off icon, on label, off label)
    "game": ("game-capture-on", "game-capture-off", "Game on", "Game off"),
    "display": ("display-capture-on", "display-capture-off", "Desktop on", "Desktop off"),
    "mic": ("microphone-on", "microphone-off", "Mic on", "Mic off"),
    "listen": ("headset-monitor-on", "headset-monitor-off", "Listen on", "Listen off"),
}


def render_toggles():
    for action, (on_icon, off_icon, on_label, off_label) in TOGGLES.items():
        on_name = "live" if action == "game" else "on"
        save_with_pressed(f"keys/{action}-{on_name}", icon=on_icon, label=on_label, badge=BLUE)
        save_with_pressed(
            f"keys/{action}-off", icon=off_icon, label=off_label, badge=GREY, label_color=TEXT_OFF
        )
        render_unavailable(action, off_icon)
        save(render_key(icon=off_icon, label="No source", badge=AMBER, label_color=TEXT_OFF), f"keys/{action}-missing")

    for frame in range(SPINNER_FRAMES):
        save(
            render_key(
                icon="game-capture-on",
                label="Connecting",
                badge=tuple(round_px(c * 0.55) for c in BLUE),
                label_color=(147, 197, 253),
                spinner=frame,
            ),
            f"keys/game-connecting-{frame:02d}",
        )


def render_unavailable(action, off_icon, badge=DARK):
    for suffix, label in (("offline", "OBS offline"), ("wsoff", "WS disabled")):
        save(
            render_key(icon=off_icon, label=label, badge=badge, label_color=TEXT_DIM, glyph_alpha=0.45),
            f"keys/{action}-{suffix}",
        )


def render_save():
    save_with_pressed("keys/save-ready", icon="record", label="Save replay")
    save_with_pressed("keys/save-inactive", icon="record-slash", label="Replay off", label_color=TEXT_OFF)
    save(render_key(icon="success", label="Saved"), "keys/save-saved")
    save(render_key(icon="failure", label="Failed"), "keys/save-failed")
    render_unavailable("save", "record-slash", badge=None)


def render_list_icons():
    for action, name in (
        ("game", "game-capture-on"),
        ("display", "display-capture-on"),
        ("mic", "microphone-on"),
        ("listen", "headset-monitor-on"),
        ("save", "record"),
    ):
        icon = Image.open(ICONS / f"{name}.png").convert("RGBA")
        icon.resize((40, 40), Image.LANCZOS).save(OUT / "actions" / f"{action}@2x.png")
        icon.resize((20, 20), Image.LANCZOS).save(OUT / "actions" / f"{action}.png")

    glyph = Image.open(ICONS / "game-capture-on.png").convert("RGBA")
    glyph.resize((56, 56), Image.LANCZOS).save(OUT / "category@2x.png")
    glyph.resize((28, 28), Image.LANCZOS).save(OUT / "category.png")

    plugin = render_key(icon="game-capture-on", label="Clip Manager", badge=BLUE)
    plugin.resize((512, 512), Image.LANCZOS).save(OUT / "plugin@2x.png")
    plugin.resize((256, 256), Image.LANCZOS).save(OUT / "plugin.png")


if __name__ == "__main__":
    (OUT / "actions").mkdir(parents=True, exist_ok=True)
    render_toggles()
    render_save()
    render_list_icons()
    print(f"rendered into {OUT}")
