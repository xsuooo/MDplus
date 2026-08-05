#!/usr/bin/env python3
"""MDPlus 桌面图标生成器 v3 —— 清晰「MD+」字标

设计：圆角渐变磁贴 + 居中粗体「MD」+ 右上标彩色「+」（代表 Plus）。
用系统 Arial Bold 渲染文字，比手绘线条清晰，缩到 16px 仍可读。
1024 超采样绘制后降采样到各目标尺寸。

用法：python make_icon.py
"""

import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

S = 1024

FONT = "C:/Windows/Fonts/arialbd.ttf"

# 三个配色方案（磁贴渐变 / MD 颜色 / + 颜色）
THEMES = {
    "A": {
        "name": "Indigo → Cyan（白 MD+）",
        "grad0": (99, 102, 241), "grad1": (6, 182, 212),
        "md": (255, 255, 255), "plus": (16, 185, 129),
    },
    "B": {
        "name": "Dark Slate（白 MD+）",
        "grad0": (30, 41, 59), "grad1": (51, 65, 85),
        "md": (255, 255, 255), "plus": (56, 189, 248),
    },
    "C": {
        "name": "Violet → Pink（白 MD+）",
        "grad0": (139, 92, 246), "grad1": (236, 72, 153),
        "md": (255, 255, 255), "plus": (245, 158, 11),
    },
}


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def make_gradient(g0, g1):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    px = img.load()
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * (S - 1))
            px[x, y] = lerp(g0, g1, t) + (255,)
    return img


def rounded_tile_mask(radius):
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=255)
    return m


def render_mdplus(theme):
    t = THEMES[theme]
    base = make_gradient(t["grad0"], t["grad1"])
    d = ImageDraw.Draw(base)

    # 「MD+」一行居中，字一样大、纯白，最朴素直观
    max_w = S * 0.84
    F = 600
    while True:
        f = ImageFont.truetype(FONT, F)
        w = d.textbbox((0, 0), "MD+", font=f, anchor="mm")[2]
        if w <= max_w:
            break
        F -= 20
    d.text((S / 2, S / 2 + int(F * 0.02)), "MD+", font=f, fill=t["md"], anchor="mm")

    # 圆角磁贴裁切
    mask = rounded_tile_mask(int(S * 0.215))
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out


def save_resized(src, path, size):
    src.resize((size, size), Image.LANCZOS).convert("RGBA").save(path)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    icons_dir = os.path.join(here, "src-tauri", "icons")
    preview_dir = os.path.join(here, "icon-preview")
    os.makedirs(icons_dir, exist_ok=True)

    renders = {k: render_mdplus(k) for k in THEMES}

    a = renders["A"]
    print("生成「MD+」图标集 ->", icons_dir)
    save_resized(a, os.path.join(icons_dir, "icon.png"), 512)
    save_resized(a, os.path.join(icons_dir, "128x128.png"), 128)
    save_resized(a, os.path.join(icons_dir, "128x128@2x.png"), 256)
    save_resized(a, os.path.join(icons_dir, "32x32.png"), 32)
    for name, sz in [
        ("Square30x30Logo.png", 30), ("Square44x44Logo.png", 44),
        ("Square71x71Logo.png", 71), ("Square89x89Logo.png", 89),
        ("Square107x107Logo.png", 107), ("Square142x142Logo.png", 142),
        ("Square150x150Logo.png", 150), ("Square284x284Logo.png", 284),
        ("Square310x310Logo.png", 310), ("StoreLogo.png", 50),
    ]:
        save_resized(a, os.path.join(icons_dir, name), sz)

    ico_sizes = [256, 128, 64, 48, 32, 24, 16]
    ico_imgs = [a.resize((s, s), Image.LANCZOS).convert("RGBA") for s in ico_sizes]
    ico_imgs[0].save(
        os.path.join(icons_dir, "icon.ico"), format="ICO",
        sizes=[(s, s) for s in ico_sizes], append_images=ico_imgs[1:],
    )
    a.resize((512, 512), Image.LANCZOS).convert("RGBA").save(os.path.join(icons_dir, "icon.icns"), format="ICNS")
    print("  icon.ico / icon.icns 完成")

    for k in THEMES:
        save_resized(renders[k], os.path.join(preview_dir, f"concept-{k}.png"), 512)
    build_preview_html(preview_dir)
    print("✓ 完成")


def build_preview_html(preview_dir):
    sizes = [256, 128, 64, 48, 32, 24, 16]
    rows = ""
    for sz in sizes:
        cells = "".join(
            f'<td style="text-align:center"><img src="concept-{k}.png" width="{sz}" height="{sz}" '
            f'style="image-rendering:pixelated;border-radius:{max(2,round(sz*0.18))}px"></td>'
            for k in THEMES
        )
        rows += f"<tr><th style='font-weight:600;color:#475569;padding-right:12px'>{sz}px</th>{cells}</tr>"

    legend = "".join(
        f'<div style="display:flex;align-items:center;gap:8px;margin:6px 0">'
        f'<img src="concept-{k}.png" width="40" height="40" style="border-radius:8px">'
        f'<div><b>方案 {k}</b> — {THEMES[k]["name"]}</div></div>'
        for k in THEMES
    )

    html = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>MDPlus 图标方案对比</title>
<style>
 body{{font-family:-apple-system,Segoe UI,Roboto,'Microsoft YaHei',sans-serif;margin:0;background:#f1f5f9;color:#0f172a}}
 .wrap{{max-width:880px;margin:0 auto;padding:32px 20px}}
 h1{{font-size:22px;margin:0 0 4px}}
 .sub{{color:#64748b;font-size:14px;margin-bottom:24px}}
 .card{{background:#fff;border-radius:16px;padding:20px 24px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:20px}}
 table{{border-collapse:collapse;width:100%}}
 td,th{{padding:8px}}
 .samples{{display:flex;gap:18px;flex-wrap:wrap;margin-top:8px}}
 .chip{{text-align:center;font-size:12px;color:#64748b}}
 h2{{font-size:16px;margin:0 0 12px}}
 .note{{font-size:13px;color:#64748b;line-height:1.6}}
</style></head>
<body><div class="wrap">
<h1>MDPlus 桌面图标方案（MD+ 字标）</h1>
<div class="sub">设计：圆角渐变磁贴 + 居中粗体白字「MD+」。已写入 <code>src-tauri/icons</code> 的为<b>方案 A</b>。</div>
<div class="card"><h2>三套配色</h2>{legend}</div>
<div class="card"><h2>各尺寸清晰度对比（浅色背景）</h2>
 <table><tr><th></th><th>A</th><th>B</th><th>C</th></tr>{rows}</table></div>
<div class="card"><h2>深色背景观感</h2>
 <div style="background:#0f172a;border-radius:12px;padding:24px">
  <div class="samples">
   {''.join(f'<div class="chip"><img src="concept-{k}.png" width="64" height="64" style="border-radius:14px"><div>方案 {k}</div></div>' for k in THEMES)}
  </div></div></div>
<div class="card note">说明：字标用系统 Arial Bold 渲染，缩到 16px 仍清晰。换配色改 <code>make_icon.py</code> 的 <code>THEMES</code> 后重跑即可。</div>
</div></body></html>"""
    with open(os.path.join(preview_dir, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)


if __name__ == "__main__":
    main()
