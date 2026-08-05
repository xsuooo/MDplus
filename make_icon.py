#!/usr/bin/env python3
"""MDPlus 桌面图标生成器 v2

设计：圆角渐变磁贴 + 白色「文档」(代表 Markdown 文件) + 右下角彩色「+」徽标(代表 Plus)。
在 1024px 超采样绘制后降采样到各目标尺寸，保证小尺寸(16/32px)依旧清晰。

用法：
    python make_icon.py            # 生成推荐方案 A 到 src-tauri/icons，并产出 A/B/C 预览
    python make_icon.py --theme A  # 只生成指定方案
"""

import os
import math
from PIL import Image, ImageDraw, ImageFilter

# ----------------------------------------------------------------------------
# 画布基准（超采样分辨率）
# ----------------------------------------------------------------------------
S = 1024

# 三个配色方案
THEMES = {
    "A": {  # 推荐：靛蓝 -> 青，翠绿徽标（现代、科技感，区别于旧版纯蓝青）
        "name": "Indigo → Cyan",
        "grad0": (99, 102, 241),    # #6366f1 indigo-500
        "grad1": (6, 182, 212),     # #06b6d4 cyan-500
        "badge": (16, 185, 129),    # #10b981 emerald-500
        "head":  (199, 210, 254),   # #c7d2fe 标题行
        "body":  (203, 213, 225),   # #cbd5e1 正文行
    },
    "B": {  # 紫 -> 粉，琥珀徽标（更鲜明、年轻）
        "name": "Violet → Pink",
        "grad0": (139, 92, 246),    # #8b5cf6 violet-500
        "grad1": (236, 72, 153),    # #ec4899 pink-500
        "badge": (245, 158, 11),    # #f59e0b amber-500
        "head":  (233, 213, 255),   # #e9d5ff
        "body":  (226, 232, 240),   # #e2e8f0
    },
    "C": {  # 深石板（暗色风，类似 VS Code / 极简）
        "name": "Dark Slate",
        "grad0": (30, 41, 59),      # #1e293b slate-800
        "grad1": (51, 65, 85),      # #334155 slate-700
        "badge": (56, 189, 248),    # #38bdf8 sky-400
        "head":  (148, 163, 184),   # #94a3b8
        "body":  (203, 213, 225),   # #cbd5e1
    },
}


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def make_gradient(g0, g1):
    """对角线线性渐变 RGBA 图。"""
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


def render_icon(theme):
    """在 1024 基准绘制一枚图标，返回 RGBA 图像。"""
    t = THEMES[theme]
    base = make_gradient(t["grad0"], t["grad1"])

    # 文档（白色页面）
    pw, ph = 540, 660
    px0 = (S - pw) // 2
    py0 = (S - ph) // 2
    px1, py1 = px0 + pw, py0 + ph
    page_radius = 46
    page_box = [px0, py0, px1, py1]

    # 页面投影（柔和）
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle([px0, py0 + 26, px1, py1 + 26], radius=page_radius, fill=(0, 0, 0, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(26))
    base = Image.alpha_composite(base, shadow)

    # 页面本体
    ImageDraw.Draw(base).rounded_rectangle(page_box, radius=page_radius, fill=(255, 255, 255, 255))

    d = ImageDraw.Draw(base)
    # 标题行（粗、主题浅色）
    head_w, head_h = 360, 42
    hx0 = (S - head_w) // 2
    hy = py0 + 86
    d.rounded_rectangle([hx0, hy, hx0 + head_w, hy + head_h], radius=head_h // 2, fill=t["head"] + (255,))

    # 正文行（细、灰色，长度错落，模拟 Markdown 文本）
    lines = [
        (380, 26),
        (320, 26),
        (350, 26),
        (250, 26),
    ]
    ly = hy + 96
    for w, h in lines:
        lx0 = (S - w) // 2
        d.rounded_rectangle([lx0, ly, lx0 + w, ly + h], radius=h // 2, fill=t["body"] + (255,))
        ly += h + 34

    # 「+」徽标（页面右下角）
    bcx, bcy, br = px1 - 70, py1 - 70, 96
    badge = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bd = ImageDraw.Draw(badge)
    bd.ellipse([bcx - br, bcy - br, bcx + br, bcy + br], fill=t["badge"] + (255,))
    # 白色加号
    arm = 30
    half = 56
    bd.rounded_rectangle([bcx - half, bcy - arm // 2, bcx + half, bcy + arm // 2], radius=arm // 2, fill=(255, 255, 255, 255))
    bd.rounded_rectangle([bcx - arm // 2, bcy - half, bcx + arm // 2, bcy + half], radius=arm // 2, fill=(255, 255, 255, 255))
    base = Image.alpha_composite(base, badge)

    # 圆角磁贴裁切
    mask = rounded_tile_mask(int(S * 0.215))
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out


def save_resized(src, path, size):
    img = src.resize((size, size), Image.LANCZOS).convert("RGBA")
    img.save(path)
    return img


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    icons_dir = os.path.join(here, "src-tauri", "icons")
    preview_dir = os.path.join(here, "icon-preview")
    os.makedirs(icons_dir, exist_ok=True)

    # 渲染三个方案
    renders = {k: render_icon(k) for k in THEMES}

    # ---- 方案 A：完整生产图标集，写入 src-tauri/icons（覆盖旧版）----
    a = renders["A"]
    print("生成方案 A 生产图标集 ->", icons_dir)
    save_resized(a, os.path.join(icons_dir, "icon.png"), 512)
    save_resized(a, os.path.join(icons_dir, "128x128.png"), 128)
    save_resized(a, os.path.join(icons_dir, "128x128@2x.png"), 256)
    save_resized(a, os.path.join(icons_dir, "32x32.png"), 32)

    # 微软商店 Square* / StoreLogo
    for name, sz in [
        ("Square30x30Logo.png", 30), ("Square44x44Logo.png", 44),
        ("Square71x71Logo.png", 71), ("Square89x89Logo.png", 89),
        ("Square107x107Logo.png", 107), ("Square142x142Logo.png", 142),
        ("Square150x150Logo.png", 150), ("Square284x284Logo.png", 284),
        ("Square310x310Logo.png", 310), ("StoreLogo.png", 50),
    ]:
        save_resized(a, os.path.join(icons_dir, name), sz)

    # 多尺寸 ICO：PIL 必须以最大图作为首图 + append_images 才能正确写入全部尺寸
    ico_sizes = [256, 128, 64, 48, 32, 24, 16]
    ico_imgs = [a.resize((s, s), Image.LANCZOS).convert("RGBA") for s in ico_sizes]
    ico_imgs[0].save(
        os.path.join(icons_dir, "icon.ico"), format="ICO",
        sizes=[(s, s) for s in ico_sizes], append_images=ico_imgs[1:],
    )
    print("  icon.ico 完成")

    # ICNS（macOS 打包用，512 基准）
    a.resize((512, 512), Image.LANCZOS).convert("RGBA").save(os.path.join(icons_dir, "icon.icns"), format="ICNS")
    print("  icon.icns 完成")

    # ---- 预览：A/B/C 各 512 + 生成对比页面 ----
    print("生成预览 ->", preview_dir)
    for k in THEMES:
        save_resized(renders[k], os.path.join(preview_dir, f"concept-{k}.png"), 512)
    build_preview_html(preview_dir)
    print("✓ 完成")


def build_preview_html(preview_dir):
    sizes = [256, 128, 64, 48, 32, 24, 16]
    rows = ""
    for sz in sizes:
        cells = ""
        for k in THEMES:
            cells += f'<td style="text-align:center"><img src="concept-{k}.png" width="{sz}" height="{sz}" style="image-rendering:pixelated;border-radius:{max(2,sz*0.18)}px"></td>'
        cells += f'<td style="text-align:center"><img src="old.png" width="{sz}" height="{sz}" style="image-rendering:pixelated;border-radius:{max(2,sz*0.18)}px"></td>'
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
 .old{{background:#fff7ed;color:#9a3412;font-weight:600;font-size:13px}}
 .samples{{display:flex;gap:18px;flex-wrap:wrap;margin-top:8px}}
 .chip{{text-align:center;font-size:12px;color:#64748b}}
 h2{{font-size:16px;margin:0 0 12px}}
 .note{{font-size:13px;color:#64748b;line-height:1.6}}
</style></head>
<body><div class="wrap">
<h1>MDPlus 桌面图标方案</h1>
<div class="sub">设计：圆角渐变磁贴 + 白色文档(Markdown 文件) + 彩色「+」徽标(Plus)。已写入 <code>src-tauri/icons</code> 的为<b>方案 A</b>。</div>

<div class="card">
 <h2>三套配色</h2>{legend}
</div>

<div class="card">
 <h2>各尺寸清晰度对比（浅色背景）</h2>
 <table>
  <tr><th></th><th>A</th><th>B</th><th>C</th><th class="old">旧版</th></tr>
  {rows}
 </table>
</div>

<div class="card">
 <h2>深色背景下的观感</h2>
 <div style="background:#0f172a;border-radius:12px;padding:24px">
  <div class="samples">
   {''.join(f'<div class="chip"><img src="concept-{k}.png" width="64" height="64" style="border-radius:14px"><div>方案 {k}</div></div>' for k in THEMES)}
   <div class="chip"><img src="old.png" width="64" height="64" style="border-radius:14px"><div>旧版</div></div>
  </div>
 </div>
</div>

<div class="card note">
 说明：小尺寸(16/24/32px)靠降采样保留主体轮廓——渐变磁贴 + 白文档 + 彩色徽标，辨识度足够。
 若想换配色，改 <code>make_icon.py</code> 里 <code>THEMES</code> 后重跑即可；要换主图形（如改成 Markdown 的「M↓」符号）告诉我。
</div>
</div></body></html>"""
    with open(os.path.join(preview_dir, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)


if __name__ == "__main__":
    main()
