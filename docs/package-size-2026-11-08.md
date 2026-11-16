# 2026-11-08 安装包体积排查

六份完整中文字体是当前 40–60 MB 安装包的主要体积来源，并非项目打入了 Chromium。它们合计 **43,956,156 字节（41.92 MiB）**，约占本轮生产前端产物的 88%。这里的 MiB 按 1,048,576 字节计算。

当前业务保留三组离线中文字体、真实强调字重、完整字集以及离线 HTML/PDF 导出。不能通过删除字重、截取常用汉字或改为联网加载来声称等价修复。

## 本轮修复

[字体资源模块](../src/lib/fontResources.ts)原先用整个字体目录的 eager glob 收集资源。目录中后来加入的原件、备份或未使用字体也会进入安装包。现在只显式引用显示和导出需要的九个字体文件，保留原有字体选择、字重、许可和资源读取错误处理。

现有目录恰好只有这九个文件，因此这项修复防止意外夹带资源，没有删减当前字库。仅调整字体资源引用后的独立构建，其 JavaScript 比盘点时已有的 `dist` 少 332 字节；不能将它描述为数十 MB 的安装包缩减。下方最终产物还包含编辑器性能修复。

[新增打包回归](../tests/fontPackaging.test.ts)通过真实 Vite 构建同时引入显示 CSS 和离线导出模块，确认九个字体各输出一份、字节与源文件一致、CSS 和导出复用同一资源，以及所有字体面的属性保持不变。

另一项隔离夹具在字体目录增加未引用的 WOFF2 文件，确认它不会进入产物。夹具仅使用合成字节，不改动业务字体。

## 新生成的前端产物

本轮 NSIS 构建所用的最终 Vite 前端产物总计 **49,972,980 字节（47.66 MiB）**。这是前端产物大小，不是 Windows 安装器大小，也不代表安装后的磁盘占用。

| 组成                               |       字节 |
| ---------------------------------- | ---------: |
| 六份完整中文字体                   | 43,956,156 |
| 三份拉丁字体及 KaTeX 字体          |  1,203,984 |
| JavaScript，包括按需加载的图表模块 |  4,618,235 |
| CSS                                |     88,706 |
| 字体许可、HTML 和图标              |    105,899 |

| 中文字体家族     | 字重     |   合计字节 |
| ---------------- | -------- | ---------: |
| MiSans           | 400、600 |  9,892,836 |
| Sarasa Gothic SC | 400、600 | 16,817,860 |
| LXGW WenKai      | 400、500 | 17,245,460 |

九个业务字体的生产资产哈希均与源文件一致，而且各自只出现一次。CSS、首页字体预加载和离线导出没有重复打包这些字体。生产产物没有 source map。

## 实际 NSIS 构建

已重新生成 Windows x64 NSIS 安装器，版本为 `0.2.6`，构建标识为 `editor-performance-20261108`。构建及初次审计约用时 173 秒；前后来源清单的 290 个输入文件保持一致。

| 实际测量对象                |       字节 |   MiB |
| --------------------------- | ---------: | ----: |
| NSIS 安装器                 | 48,420,320 | 46.18 |
| 从安装器提取的 `mdplus.exe` | 53,345,792 | 50.87 |

安装器 SHA256：

```text
1672fe70b5428fc5c9a27e599145ea49dce98640797aa4d6d456ff0041c0d6ce
```

包内 EXE SHA256：

```text
022e9f7f26cc7fc2996656baff5de145fbc13fe3fddbd23a90b79dcc320e4f0f
```

来源清单 SHA256：

```text
2253a7f7b4519a420badedb8cca2a967635e5a756b55ee13f1194a878fc23a16
```

7-Zip 的完整归档校验通过，提取后的 PE 版本为 `0.2.6`。清单中维护助手和主程序指向相同的压缩数据偏移，没有将完整 EXE 载荷压缩存储两次；安装器也没有夹带 PDB、Rust 静态库、source map 或 WebView2 离线安装器。

初次审计脚本错误地要求包内 EXE 与裸 release EXE 完全一致。Tauri 的已核实行为是在打包时将唯一 `__TAURI_BUNDLE_TYPE_VAR_UNK` 标记改为 `__TAURI_BUNDLE_TYPE_VAR_NSS`。本轮两文件仅这三个字节不同；严格复核只允许该唯一标记替换，其余全部字节一致。初次失败记录保留在 `nsis-release/result.json`，通过的归档、哈希、版本和标记核验保存在 `nsis-release/verification.json`，没有覆盖失败证据。

此安装器仍为 46.18 MiB，原因是继续完整交付 41.92 MiB 中文字库。它没有被安装或发布；构建成功与字节核验不代表原生安装验收通过。

## 已有优化与排除项

- `Cargo.lock` 锁定的 Tauri Rust crate 为 2.11.5，已安装 CLI 为 2.11.4。二者独立发布，版本号不必相同。
- Rust release 已使用 `opt-level = "s"`、ThinLTO、单个 codegen unit 和符号裁剪，同时保留现有 panic unwinding。没有再次改动这些配置。
- 既有 [KaTeX 构建处理](../config/katexFonts.ts)已移除重复 WOFF/TTF 回退，保留全部 20 个 WOFF2 字体面；本轮重新执行相关构建回归。
- 当前 Tauri 配置没有增加 `resources` 或 `externalBin`，NSIS 模板使用 solid LZMA。WebView2 安装模式采用 CLI 默认的 `downloadBootstrapper`，没有嵌入完整离线运行时。`target` 中的 PDB、静态库和中间产物不因存在于目录里而自动进入安装包。
- Mermaid 已按需加载。代码分包改变首次加载量，不会自动减少需要离线交付的图表功能总量。

先前实际 NSIS 对比保存在[候选构建记录](ops/candidate-0.2.6.md)中。那些旧包不能作为本轮源码的安装器测量结果。

## 可变字体评估

当前六个中文字体文件都是静态单字重，各家族两个文件的字符覆盖一致。三个拉丁字体已经是可变字体，不能通过再次改成可变字体来压缩。

本轮从此前缓存的官方 `MiSans.zip` 提取 `MiSansVF.ttf`，在审计目录进行完整字集、无字形表转换的 WOFF2 包装评估，未替换业务资源：

| MiSans 方案                           |       字节 |
| ------------------------------------- | ---------: |
| 当前两个官方静态 WOFF2                |  9,892,836 |
| 官方完整可变 TTF                      | 20,093,424 |
| 完整可变字体的无字形表转换 WOFF2 包装 | 12,783,656 |

该可变字体覆盖相同的 29,571 个码位，但上述 WOFF2 包装比现有两个静态文件多 2,890,820 字节。其命名实例 Regular 为 `wght=330`，Semibold 为 `wght=520`；不能直接沿用当前 CSS 的 400/600 权重而假定字形一致。

因此没有采用这一变体。本轮没有尝试裁剪可变轴、重新生成字体轮廓或替换 Sarasa/LXGW 字体版本，也没有将未经验证的可变字体收益计入结果。Cascadia 原 TTF 同样保留：减小单个前端文件并不保证其二次压缩后的安装器更小。

另外进行了只读字形可达性盘点，纳入全部 cmap、Unicode 变体选择和 GSUB 功能。每个 LXGW 文件最多还剩 2 个未解析字形、MiSans 57 个、Sarasa 115 个，不超过各文件字形数的 0.24%。这些字形还可能被复合字形或其他表引用，不能直接当作安全可删除项；本轮没有为这点潜在收益改写字库、GSUB/GPOS 或 hinting。

## 验证与复现

以下针对本轮字体资源改动的检查通过：

```powershell
npx vitest run tests/fontPackaging.test.ts tests/katexPackaging.test.ts tests/exportCapacity.test.ts
npx eslint src/lib/fontResources.ts tests/fontPackaging.test.ts --max-warnings 0
npx prettier --check src/lib/fontResources.ts tests/fontPackaging.test.ts docs/package-size-2026-11-08.md
```

三份测试文件的 12 项测试通过。独立 Vite 生产构建通过，耗时约 8 秒。首次构建因系统 TEMP 中的 esbuild 临时文件删除被拒绝而失败；重试仅为该构建进程设置审计目录内的 TEMP/TMP，并在退出时恢复，没有修改系统环境或 ACL。

本轮证据保存在 `.audit/editor-performance-20261108-073718/`：`bundle-size-baseline.json` 为已有产物及源字体盘点，`bundle-size-production.json` 为仅字体引用调整后的独立构建，`bundle-size-final-production.json` 为最终 NSIS 所用前端产物和去重核验，`font-metadata.json` 为当前字体元数据，`font-probe/misans-variable.json` 为可变字体评估，`font-reachability-probe.json` 为可达性盘点。

安装器、包内 EXE 和核验报告位于同一证据目录下的 `nsis-release/`。本轮没有执行安装器、替换用户的已安装版本或进行原生安装验收；后续源码变化需要重新构建，不能继续沿用这里的哈希。
