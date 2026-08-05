#!/usr/bin/env python3
"""生成 MDPlus 应用图标"""

from PIL import Image, ImageDraw
import os

def create_rounded_rectangle_mask(size, radius):
    """创建圆角矩形蒙版"""
    mask = Image.new('L', (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([(0, 0), (size-1, size-1)], radius=radius, fill=255)
    return mask

def draw_icon(size):
    """绘制图标"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 圆角半径
    radius = int(size * 0.1875)  # 96/512

    # 背景渐变 - 使用纯色代替渐变（PIL 的渐变支持有限）
    bg = Image.new('RGB', (size, size))
    bg_draw = ImageDraw.Draw(bg)

    # 创建简单的线性渐变
    for y in range(size):
        # 从 #0ea5e9 到 #06b6d4
        r = int(14 + (6 - 14) * y / size)
        g = int(165 + (182 - 165) * y / size)
        b = int(233 + (212 - 233) * y / size)
        bg_draw.line([(0, y), (size, y)], fill=(r, g, b))

    # 应用圆角蒙版
    mask = create_rounded_rectangle_mask(size, radius)
    bg.putalpha(mask)
    img = Image.alpha_composite(img, bg.convert('RGBA'))

    draw = ImageDraw.Draw(img)

    # 缩放因子
    scale = size / 512

    # 线条宽度
    line_width = max(1, int(42 * scale))
    thin_line = max(1, int(32 * scale))

    # M 字母
    m_points = [
        (int(120*scale), int(320*scale)),
        (int(120*scale), int(180*scale)),
        (int(190*scale), int(240*scale)),
        (int(260*scale), int(180*scale)),
        (int(260*scale), int(320*scale))
    ]
    draw.line(m_points[:3], fill='white', width=line_width, joint='curve')
    draw.line(m_points[2:], fill='white', width=line_width, joint='curve')

    # D 字母 - 垂直线
    draw.line([
        (int(310*scale), int(180*scale)),
        (int(310*scale), int(320*scale))
    ], fill='white', width=line_width)

    # D 字母 - 圆弧（使用椭圆的右半部分）
    arc_bbox = [
        int(310*scale), int(180*scale),
        int(405*scale), int(320*scale)
    ]
    draw.arc(arc_bbox, start=-90, end=90, fill='white', width=int(38*scale))

    # 加号符号 - 水平线
    draw.line([
        (int(140*scale), int(380*scale)),
        (int(240*scale), int(380*scale))
    ], fill='white', width=thin_line)

    # 加号符号 - 垂直线
    draw.line([
        (int(190*scale), int(330*scale)),
        (int(190*scale), int(430*scale))
    ], fill='white', width=thin_line)

    return img

def main():
    """生成所有尺寸的图标"""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    icons_dir = os.path.join(script_dir, 'src-tauri', 'icons')

    # 确保图标目录存在
    os.makedirs(icons_dir, exist_ok=True)

    # 生成不同尺寸
    sizes = {
        'icon.png': 512,
        '128x128@2x.png': 256,
        '128x128.png': 128,
        '32x32.png': 32,
        'Square30x30Logo.png': 30,
        'Square44x44Logo.png': 44,
        'Square71x71Logo.png': 71,
        'Square89x89Logo.png': 89,
        'Square107x107Logo.png': 107,
        'Square142x142Logo.png': 142,
        'Square150x150Logo.png': 150,
        'Square284x284Logo.png': 284,
        'Square310x310Logo.png': 310,
        'StoreLogo.png': 50,
    }

    for filename, size in sizes.items():
        print(f'生成 {filename} ({size}x{size})...')
        icon = draw_icon(size)
        icon.save(os.path.join(icons_dir, filename))

    # 生成 ICO 文件（多尺寸）
    print('生成 icon.ico...')
    ico_sizes = [16, 32, 48, 64, 128, 256]
    ico_images = [draw_icon(s) for s in ico_sizes]
    ico_images[0].save(
        os.path.join(icons_dir, 'icon.ico'),
        format='ICO',
        sizes=[(s, s) for s in ico_sizes],
        append_images=ico_images[1:]
    )

    print('✓ 所有图标已生成')

if __name__ == '__main__':
    try:
        main()
    except ImportError:
        print('错误: 需要安装 Pillow 库')
        print('运行: pip install Pillow')
        exit(1)
