MDPlus bundled fonts
====================

MDPlus uses MiSans fonts, copyright Xiaomi Technology Co., Ltd.
MiSans is distributed only as part of this application, under the included
MiSans-License.pdf. The official WOFF2 is included without modification.
Official download: https://hyperos.mi.com/font/download
Official FAQ: https://hyperos.mi.com/font/zh/faq
Package: https://hyperos.mi.com/font-download/MiSans.zip
Files: MiSans/woff2/MiSans-Regular.woff2 and MiSans-Semibold.woff2 (2025-01-24)

The other five families use the SIL Open Font License 1.1. Their full notices
and license texts are included alongside this file.

JetBrains Mono 2.304
Source: https://github.com/JetBrains/JetBrainsMono/tree/v2.304
File: fonts/variable/JetBrainsMono[wght].ttf
License: JetBrainsMono-OFL.txt

Sarasa Gothic SC 1.0.43
Source: https://github.com/be5invis/Sarasa-Gothic/releases/tag/v1.0.43
Files: SarasaGothicSC-Regular.ttf and SarasaGothicSC-SemiBold.ttf
from SarasaGothicSC-TTF-1.0.43.7z
License: Sarasa-OFL.txt

LXGW WenKai 1.530
Source: https://github.com/lxgw/LxgwWenKai/releases/tag/v1.530
Files: LXGWWenKai-Regular.ttf and LXGWWenKai-Medium.ttf
License: LXGWWenKai-OFL.txt

Fira Code and Cascadia Code
Source: https://github.com/google/fonts/tree/6157dfaa640ca5738b4d1a7070fe389c3036d7fc/ofl
Files: firacode/FiraCode[wght].ttf and cascadiacode/CascadiaCode[wght].ttf
Licenses: FiraCode-OFL.txt and CascadiaCode-OFL.txt

JetBrains Mono, Fira Code, Sarasa Gothic SC and LXGW WenKai are losslessly
converted to WOFF2 using fontTools 4.65.0 for embedded WebView delivery.
No glyphs are subsetted or redesigned. Cascadia Code uses the original TTF.
These fonts are not installed into the operating system by MDPlus.

Latin variable-font weights are preserved. MiSans and Sarasa use their real
Semibold (600) face for emphasis; LXGW WenKai uses its real Medium (500) face.
The application disables synthesized bold in reading/code surfaces; italic may
be synthesized. Fonts are loaded only when a selected role needs them. The
default MiSans regular face is preloaded for first-paint reading.
