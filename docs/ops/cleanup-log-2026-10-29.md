# 清理与发布执行记录 · 2026-10-29 → 2026-10-30

> 配套文件：`cleanup-release-runbook.md`（步骤）、`cleanup-manifest-2026-10-29.csv`（清单）、`cleanup-2026-10-29.log`（原始日志；`*.log` 被 .gitignore 忽略，入库需 `git add -f`）
> 仓库：`xsuooo/MDplus`（public） · 分支：`agent/bootstrap` · 基线 HEAD：`9a2fae15a26d1b3d15868c6c5be6a18440786d18`
> 执行窗口：2026-10-30 00:12 – 00:33 (+08:00) · 备份根目录：`D:\My Project\_backup\MDplus\2026-10-29\`

## 1. 参数确认

| 参数 | 决定 | 确认人 | 确认时间 |
|------|------|--------|----------|
| 标签名 / 版本号 | `v0.2.4` / `0.2.4` | 用户（按建议执行） | 2026-10-30 00:0x |
| 清理范围 | C04 `dist`、C05 `src-tauri\target`、C07 `fn-key-shortcuts.diff`；C08 不删 | 同上 | 同上 |
| 审计保留期 | 7 天 → `.audit` 本轮全部保留 | 同上 | 同上 |
| 白名单 | Runbook 第 4 步断言列表（含 `.audit\2026-10-29`、`src`、`src-tauri\src`、`public`、`docs\ops`、`.git`、`node_modules`） | 同上 | 同上 |
| 是否推送发布 | 是（push tag + `gh release create`，公开可见） | 同上 | 同上 |

## 2. 预检结果（实测）

| 检查项 | 结果 | 判定 |
|--------|------|------|
| 工作区根 / 分支 | `D:/My Project/MDplus` · `agent/bootstrap` → `origin/agent/bootstrap` | ✅ |
| HEAD / 发散计数 | `9a2fae1…` · `0 0` | ✅ |
| 未跟踪项 | 4 条：`.audit/`、`docs/fn-key-shortcuts-plan.md`、`docs/ops/`、`fn-key-shortcuts.diff` | ✅ 已知 |
| 现有标签 / Release | 最新 `v0.2.3`；`v0.2.4` 不存在 | ✅ |
| 仓库完整性 | `git fsck --connectivity-only`：仅 dangling tree/commit（历史遗留对象，非损坏） | ✅ |
| 提交身份 | `user.name`=xsuooo，`user.email` 长度 41、格式合法；此前看到的 `{{EMAIL_*}}` 是工具输出脱敏，非占位符 | ✅ 无需改配置 |

## 3. 清理清单与执行结果

清单来源：`cleanup-manifest-2026-10-29.csv`（8 项）。删除前先把 0.2.4 安装包移出 `src-tauri\target`（未随 Release 分发，见第 9 节）。

| 序号 | 路径 | 类别 | 文件数 | 大小(MB) | 决定 | 执行结果 | 耗时 |
|------|------|------|--------|----------|------|----------|------|
| C01 | `.audit\2026-10-27` | Audit | 19268 | 243.5 | 保留（7 天期内） | 未执行 | — |
| C02 | `.audit\2026-10-28` | Audit | 675 | 142.9 | 保留（7 天期内） | 未执行 | — |
| C03 | `.audit\2026-10-29` | Audit | 1130 | 255.7 | 保留（发布证据） | 未执行，校验后仍为 1130 个文件 | — |
| C04 | `dist` | Regen | 127 | 5.1 | 删除 | ✅ 已删除，残留 exists=False | 0.6s |
| C05 | `src-tauri\target` | Regen | 24551 | 16177.6 | 删除 | ✅ 已删除，残留 exists=False | 18.7s |
| C06 | `node_modules` | Regen | 19350 | 266.7 | 保留 | 未执行 | — |
| C07 | `fn-key-shortcuts.diff` | Patch | 1 | 0.1 | 归档后删 | ✅ 已删除，残留 exists=False | 0s |
| C08 | `docs\fn-key-shortcuts-plan.md` | Doc | 1 | 0.0 | 待定（不删） | 保持未跟踪，已归档 | — |

删除合计回收 **13.24 GB**（D 盘可用空间 92.5 GB）。回收值小于 C05 的标称 16177.6 MB：`target` 内含大量稀疏/压缩文件，实际占盘小于逻辑大小。

## 4. 归档索引

备份根目录：`D:\My Project\_backup\MDplus\2026-10-29\`（仓库之外，同盘，建议保留 30 天）

| 目标 | 归档文件 | 文件数 | 字节 | SHA256 | 校验 |
|------|----------|--------|------|--------|------|
| `fn-key-shortcuts.diff` | `fn-key-shortcuts.diff.tar.gz` | 1 | 54176 | `B66C2F6128E77B21CDD78603066FB1AE120A2D9ADC75C81B464B0C5280490A6C` | OK（解包逐文件比对一致） |
| `docs\fn-key-shortcuts-plan.md` | `docs_fn-key-shortcuts-plan.md.tar.gz` | 1 | 18681 | `FB81BD547AFCBC97AE9E565023FB54EBCA83C1A2E6241B72F9BE24A430738B42` | OK（解包逐文件比对一致） |

索引文件：`archive-index.csv`（含 Files/Bytes/SHA256，R1 恢复时用于比对）。安装包副本：`bundle\MDPlus_0.2.4_x64_zh-CN.msi`（sha256 `C389DD394E3FA9E37592C32ABD9CA01D260DD718E9909D3571B049D18429E75A`）、`bundle\MDPlus_0.2.4_x64-setup.exe`（sha256 `A4DFD6802802913EF00B8DB17739E3B8058E31F728B9228C3F2875A78DBD99A7`）。

## 5. 删除与校验

| 检查项 | 期望 | 实测 | 判定 |
|--------|------|------|------|
| C04 残留 | False | False | ✅ |
| C05 残留 | False | False | ✅ |
| C07 残留 | False | False | ✅ |
| 回收空间 | ≥ 12 GB | 13.24 GB | ✅ |
| `.audit\2026-10-29` 文件数 | 1130 | 1130（255.7 MB） | ✅ 未被触碰 |
| 已跟踪文件改动 | 无 | 无（`git status` 仅未跟踪项） | ✅ |
| 仓库完整性 | 无损坏 | 仅 dangling tree/commit（历史遗留） | ✅ |
| 磁盘可用 | 增加 | 92.5 GB | ✅ |

## 6. 回滚演练记录

| 日期 | 演练对象 | 命令 | 结果 | 耗时 |
|------|----------|------|------|------|
| 2026-10-30 00:19 | `fn-key-shortcuts.diff.tar.gz` | `tar -xzf → 临时目录 → 计数/字节/首行可读 | ✅ 1 文件 / 54176 字节，首行可读 | < 5s |

**结论**：被删文件可回滚；恢复命令见 Runbook 第 8 章 R1，校验依据为 `archive-index.csv` 的 Files/Bytes/SHA256。

## 7. 发布记录

| 项 | 值 |
|----|----|
| 版本 / 标签 | 0.2.4 / `v0.2.4`（annotated） |
| 发布提交 | `6b23e2e466b0defccc5f8ffe83de924fcd9b372c`（`chore(release): v0.2.4`） |
| 标签指向 | `git rev-list -n 1 v0.2.4` = 6b23e2e…（与发布提交一致，`git cat-file -t` = tag） |
| 基线 HEAD | `9a2fae15a26d1b3d15868c6c5be6a18440786d18` |
| 分支推送 | `9a2fae1..6b23e2e` → `agent/bootstrap`，发散计数 0 0 |
| Release URL | https://github.com/xsuooo/MDplus/releases/tag/v0.2.4 |
| Release 状态 | `isDraft=false`，`isPrerelease=false`，标题「MDPlus v0.2.4 - 功能键快捷入口与源码撤销」 |
| 随包资产 | `MDPlus_0.2.4_x64-setup.exe`（4,257,861 B）、`MDPlus_0.2.4_x64_zh-CN.msi`（5,423,104 B），**未签名**，按维护者决定直接分发；GitHub digest 与本地 SHA256 一致 |
| CHANGELOG | v0.2.4 已由「候选」转正，「不创建版本标签或 Release」已改写为已发布说明 |
| 执行人 / 复核人 | 用户确认 / 独立复核（runbook-reviewer） |

## 8. 工作区最终状态

| 路径 | 状态 | 说明 |
|------|------|------|
| `docs/fn-key-shortcuts-plan.md` | **已入库** | 《MDPlus 快捷键改造与编辑异常排查》开发与测试执行说明（269 行），随本次提交进入仓库；副本仍在备份目录 |
| `.audit/` | 已加入 `.gitignore` | 本轮起不再出现在 `git status` |

## 9. 未决事项

- `docs/fn-key-shortcuts-plan.md` 已入库；若不需要，`git rm docs/fn-key-shortcuts-plan.md` 即可移出，备份目录留有副本。
- 安装包未签名即随 Release 分发（个人项目不做代码签名，维护者决定）；如日后补签名，替换资产用 `gh release upload v0.2.4 <文件> --clobber`。
- 本轮按 7 天保留期未删任何审计日志；后续可按月执行，判据用 `docs/ops/cleanup-manifest-<日期>.csv`。
- `git fsck` 报出的 dangling tree/commit 为仓库历史遗留对象，非本次操作产生。
