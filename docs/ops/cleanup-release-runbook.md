# MDPlus 临时/审计文件清理与 v0.2.4 发布 Runbook

> 历史流程记录，不作为当前发布或删除授权。当前状态见 [README](../../README.md)，交付与回退统一使用 [Windows 交付入口](windows-delivery.md)。下文保留当时的参数及结论。

> 适用仓库：`D:\My Project\MDplus`（GitHub `xsuooo/MDplus`，public，默认分支 `agent/bootstrap`）
> 目标环境：Windows 11 x64 · PowerShell 7 · Git for Windows · GitHub CLI 已登录（`xsuooo`，scope 含 `repo`/`workflow`）
> 编制时间：2026-10-29 · 基线 HEAD：`9a2fae15a26d1b3d15868c6c5be6a18440786d18`（`docs: record completed installer acceptance`）
> 执行原则：**先备份、后删除；每步可验证；未确认路径一律不动；破坏性步骤必须双人确认。**

---

## 0. 待确认参数（未确认前不得执行第 4、7 步）

| # | 参数 | 建议值 | 状态 | 阻塞的步骤 |
|---|------|--------|------|-----------|
| P1 | 标签名 | `v0.2.4`（沿用 vX.Y.Z 历史格式） | ⛔ 待你确认 | 第 7 步 |
| P2 | 版本号 | `0.2.4`（与 `package.json`、CHANGELOG 一致） | ⛔ 待你确认 | 第 7 步 |
| P3 | 清理范围 | C04 `dist`、C05 `src-tauri\target`、C07 `fn-key-shortcuts.diff`；C08 待定 | ⛔ 待你确认 | 第 3–4 步 |
| P4 | 审计保留期 | 7 天 | ⛔ 待你确认 | C01/C02/C03 去留 |
| P5 | 白名单 | 见第 4 步断言列表 | 建议采纳 | 第 4 步 |
| P6 | 是否推送发布 | 是（push tag + `gh release create`，公开可见） | ⛔ 待你确认 | 第 7 步 |

**关键结论（按建议参数 P3+P4）**：`.audit` 下三个目录（C01 1.9 天、C02 1.1 天、C03 当日）全部落在 7 天保留期内，**本轮不删除任何审计日志**；真正可清理的是 16.2 GB 的 Rust 构建缓存与 5.1 MB 前端产物。若要求立刻压缩审计目录，把 `$AuditRetentionDays` 改为 `1`，C01/C02 才会进入可删集合（此时必须先归档）。

确认后在 `docs/ops/cleanup-log-2026-10-29.md` 的「参数确认」段落记录确认人与时间。

---

## 1. 预检：确认工作区与远程仓库状态

```powershell
$Repo = 'D:\My Project\MDplus'
Set-Location $Repo
$ErrorActionPreference = 'Stop'

git rev-parse --show-toplevel
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git status --porcelain=v1 -b --untracked-files=normal
git rev-list --left-right --count 'HEAD...@{upstream}'
git tag --sort=-creatordate | Select-Object -First 5
gh release list --limit 3
git fsck --connectivity-only --no-progress
Get-PSDrive D | Select-Object Name, @{ n='FreeGB'; e={ [math]::Round($_.Free/1GB,1) } }
```

**预期输出（2026-10-29 实测）**

```text
D:/My Project/MDplus
agent/bootstrap
9a2fae15a26d1b3d15868c6c5be6a18440786d18
## agent/bootstrap...origin/agent/bootstrap
?? .audit/
?? docs/fn-key-shortcuts-plan.md
?? docs/ops/
?? fn-key-shortcuts.diff
0       0
v0.2.3
v0.2.2
v0.2.1
v0.2.0
v0.1.4
MDPlus v0.2.3 - 快捷键、编辑器缩放与源码粘图  Latest  v0.2.3  2026-10-17T19:00:49Z
MDPlus v0.2.2 - 图标改版与图片引用保留               v0.2.2  2026-10-16T03:55:23Z
v0.2.1                                             v0.2.1  2026-08-17T04:20:52Z
Name FreeGB
---- ------
D       xx.x
```

**通过判据**：①`HEAD` 与 `origin/agent/bootstrap` 一致且发散计数为 `0 0`；②`git status` 只有上面 4 条未跟踪项（`docs/ops/` 是本 Runbook 自身，属预期）；③`v0.2.4` 标签不存在、Release 不存在；④`git fsck` 无输出（无损坏对象）；⑤D 盘剩余空间 > 20 GB。任一条不满足即**停止**。

### 1.1 提交身份自检（必做）

占位邮箱一旦被 commit 写进 public 仓库历史就难以彻底清除。

```powershell
$Repo = 'D:\My Project\MDplus'
Set-Location $Repo
$name  = (git config user.name  | Out-String).Trim()
$email = (git config user.email | Out-String).Trim()
'{0} <{1}>' -f $name, $email
if (-not $name -or -not $email -or $email -match '[{}]|example\.|@localhost|noreply') {
  throw "提交身份不合法：$name <$email>。先执行 git config --local user.email <你的真实邮箱>"
}
```

**通过判据**：输出真实姓名与邮箱。实测当前 `user.email` 是模板占位符（形如 `{{...}}`），**必须先改为真实邮箱**再执行第 7 步，否则发布提交的作者信息会永久留在一个 public 仓库里。

### 1.2（可选，推荐）把 `.audit/` 加入 `.gitignore`

`.audit` 目前是未跟踪目录（`*.log` 被忽略，但目录本身不是），存在被 `git add -A` 误提交的风险。

```powershell
$Repo = 'D:\My Project\MDplus'
Set-Location $Repo
Add-Content -Path '.gitignore' -Value "`n# 本地审计与验收日志（不随仓库分发）`n.audit/" -Encoding utf8
git add .gitignore
git commit -m "chore: ignore local .audit evidence directory"
git log -1 --pretty=format:'%h %s'
```

预期：`<sha> chore: ignore local .audit evidence directory`，之后 `git status` 不再列出 `?? .audit/`。

---

## 2. 盘点：生成待清理清单

清单文件：`docs/ops/cleanup-manifest-2026-10-29.csv`（已按实测生成；字段 Id/Path/Class/Files/SizeMB/AgeDays/Newest/Oldest/Policy/Decision）。
**重跑时原样执行以下命令即可重新生成**（只读扫描，不删任何文件）。

```powershell
$Repo = 'D:\My Project\MDplus'
Set-Location $Repo
$Stamp = '2026-10-29'
$AuditRetentionDays = 7
$OutDir = Join-Path $Repo 'docs\ops'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Get-TargetStat {
  param([string]$RelPath, [string]$Class, [string]$Policy)
  $full = Join-Path $Repo $RelPath
  if (-not (Test-Path -LiteralPath $full)) {
    return [pscustomobject]@{ Id=''; Path=$RelPath; Class=$Class; Files=0; SizeMB=0; AgeDays=0; Policy=$Policy; Decision='不存在' }
  }
  $item  = Get-Item -LiteralPath $full
  $files = @(Get-ChildItem -LiteralPath $full -Recurse -File -Force -ErrorAction SilentlyContinue)
  if (-not $item.PSIsContainer) { $files = @($item) }
  $sum  = ($files | Measure-Object -Property Length -Sum).Sum
  $newest = ($files | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
  $oldest = ($files | Sort-Object LastWriteTime | Select-Object -First 1).LastWriteTime
  [pscustomobject]@{
    Id=''; Path=$RelPath; Class=$Class; Files=$files.Count
    SizeMB=[math]::Round(($sum/1MB),1)
    AgeDays=[math]::Round(((Get-Date) - $newest).TotalDays,1)
    Newest=$newest.ToString('yyyy-MM-dd HH:mm'); Oldest=$oldest.ToString('yyyy-MM-dd HH:mm')
    Policy=$Policy; Decision=''
  }
}

$targets = @(
  (Get-TargetStat '.audit\2026-10-27' 'Audit'       ('保留 {0} 天' -f $AuditRetentionDays)),
  (Get-TargetStat '.audit\2026-10-28' 'Audit'       ('保留 {0} 天' -f $AuditRetentionDays)),
  (Get-TargetStat '.audit\2026-10-29' 'Audit'       '发布证据，保留'),
  (Get-TargetStat 'dist'               'Regenerable' '可重新构建'),
  (Get-TargetStat 'src-tauri\target'   'Regenerable' '可重新构建'),
  (Get-TargetStat 'node_modules'       'Regenerable' '本轮保留'),
  (Get-TargetStat 'fn-key-shortcuts.diff' 'Patch'    '归档后删除'),
  (Get-TargetStat 'docs\fn-key-shortcuts-plan.md' 'Doc' '归档或入库')
)

$i = 0
foreach ($t in $targets) {
  $i++
  $t.Id = ('C{0:D2}' -f $i)
  if ($t.Path -eq '.audit\2026-10-29') { $t.Decision = '保留（白名单：发布证据）' }
  elseif ($t.Class -eq 'Audit') {
    if ([double]$t.AgeDays -le $AuditRetentionDays) { $t.Decision = ('保留（在 {0} 天保留期内）' -f $AuditRetentionDays) }
    else { $t.Decision = '可删（超出保留期，先归档）' }
  }
  elseif ($t.Class -eq 'Regenerable') {
    if ($t.Path -eq 'node_modules') { $t.Decision = '本轮保留（删后需 npm install）' }
    else { $t.Decision = '可删（先记录重建命令）' }
  }
  elseif ($t.Class -eq 'Patch') { $t.Decision = '归档后删除' }
  elseif ($t.Class -eq 'Doc')   { $t.Decision = '待定：归档或入库' }
}

$targets | Select-Object Id,Path,Class,Files,SizeMB,AgeDays,Newest,Oldest,Policy,Decision |
  Export-Csv -Path (Join-Path $OutDir "cleanup-manifest-$Stamp.csv") -NoTypeInformation -Encoding UTF8

$targets | Format-Table Id,Path,Class,Files,SizeMB,AgeDays,Decision -AutoSize | Out-String -Width 160
```

**预期输出（实测）**

```text
Id  Path                        Class        Files  SizeMB   AgeDays Decision
C01 .audit\2026-10-27           Audit        19268  243.50     1.90  保留（在 7 天保留期内）
C02 .audit\2026-10-28           Audit          675  142.90     1.10  保留（在 7 天保留期内）
C03 .audit\2026-10-29           Audit         1130  255.70     0.00  保留（白名单：发布证据）
C04 dist                        Regenerable    127    5.10     0.50  可删（先记录重建命令）
C05 src-tauri\target            Regenerable  24551 16177.60    0.50  可删（先记录重建命令）
C06 node_modules                Regenerable  19350  266.70     0.50  本轮保留（删后需 npm install）
C07 fn-key-shortcuts.diff       Patch            1    0.10     3.00  归档后删除
C08 docs\fn-key-shortcuts-plan.md Doc            1    0.00     2.90  待定：归档或入库
```

**分类规则（决定是否必须先归档）**

| 类别 | 含义 | 备份要求 | 回滚方式 |
|------|------|----------|----------|
| Audit | 审计/验收日志，不可再生 | **必须先打包归档** | 从归档解包 |
| Patch | 一次性补丁、草稿 | **必须先打包归档** | 从归档解包 |
| Doc | 未跟踪文档 | 归档或先入库 | 从归档解包 |
| Regenerable | `dist`、`src-tauri/target`、`node_modules` | **不归档**，只记录重建命令 | 重新构建 |

**通过判据**：CSV 行数 = 8，C05 的 SizeMB > 16000，C01–C03 的 Decision 均为「保留」。清单经维护者逐行勾选后进入第 3 步。

---

## 3. 备份：归档 + 校验（删除前必须全部通过）

备份目录放在**仓库之外**（同盘、秒级移动、不污染 `git status`）：
`D:\My Project\_backup\MDplus\2026-10-29\<target>`

```powershell
$Repo   = 'D:\My Project\MDplus'
$Backup = 'D:\My Project\_backup\MDplus\2026-10-29'
Set-Location $Repo
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Backup | Out-Null

# 必须归档的项（按第 2 步清单确认；Regenerable 不在此列）
$ArchiveTargets = @(
  'fn-key-shortcuts.diff',
  'docs\fn-key-shortcuts-plan.md'
)

$results = @()
foreach ($rel in $ArchiveTargets) {
  $full = Join-Path $Repo $rel
  if (-not (Test-Path -LiteralPath $full)) { throw "归档源不存在：$rel" }
  $name    = ($rel -replace '[\\/:*?"<>|]', '_')
  $archive = Join-Path $Backup ($name + '.tar.gz')
  if (Test-Path -LiteralPath $archive) { throw "归档已存在，拒绝覆盖：$archive" }

  tar -czf $archive -C $Repo -- $rel
  if ($LASTEXITCODE -ne 0) { throw "tar 失败：$rel" }

  # 解包到临时目录做真实比对：只数条目会漏掉"两边同时少算"的缺文件
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('mdplus-verify-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    tar -xzf $archive -C $tmp
    if ($LASTEXITCODE -ne 0) { throw "归档解包失败：$rel" }
    $base = if (Test-Path -LiteralPath $full -PathType Container) { $full } else { Split-Path -LiteralPath $full -Parent }
    $srcSet = @(Get-ChildItem -LiteralPath $full -Recurse -File -Force -ErrorAction Stop |
                ForEach-Object { '{0}|{1}' -f $_.FullName.Substring($base.Length).TrimStart('\'), $_.Length } | Sort-Object)
    $dstSet = @(Get-ChildItem -LiteralPath $tmp -Recurse -File -Force -ErrorAction Stop |
                ForEach-Object { '{0}|{1}' -f $_.FullName.Substring($tmp.Length).TrimStart('\'), $_.Length } | Sort-Object)
    $diff = @(Compare-Object -ReferenceObject $srcSet -DifferenceObject $dstSet)
    if ($diff.Count -gt 0) { throw ("归档内容与源不一致：$rel 差集 " + $diff.Count + ' 项') }
    $got = $srcSet.Count
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  $results += [pscustomobject]@{
    Path     = $rel
    Archive  = $archive
    Files    = $got
    Bytes    = ($files | Measure-Object -Property Length -Sum).Sum
    SizeMB   = [math]::Round((Get-Item -LiteralPath $archive).Length/1MB, 2)
    SHA256   = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    Verified = 'OK'
  }
}

$results | Format-Table Path,Files,SizeMB,Verified -AutoSize | Out-String -Width 140
$results | Select-Object Path,Archive,Files,Bytes,SHA256,Verified |
  Export-Csv -Path (Join-Path $Backup 'archive-index.csv') -NoTypeInformation -Encoding UTF8
```

**预期输出**

```text
Path                          Files SizeMB Verified
----                          ----- ------ --------
fn-key-shortcuts.diff             1   0.01 OK
docs\fn-key-shortcuts-plan.md     1   0.01 OK
```

**重建命令记录（Regenerable 项，不归档，回滚即重建）**

```text
C04 dist             -> npm run build          （约 20-60 秒）
C05 src-tauri/target -> npm run tauri:build    （首次全量 10-30 分钟）
C06 node_modules     -> npm ci                 （约 1-3 分钟，本轮不删）
```

**通过判据**：每个归档 `Verified=OK`，条目数与源文件数一致，`archive-index.csv` 已生成，且 `tar -tzf` 可正常读取（无 CRC 报错）。**未通过不得进入第 4 步。**

> 若 P4 改为 1 天，把 C01/C02 追加到 `$ArchiveTargets` 后重跑本步；243 MB / 19,268 文件的归档预计 1-3 分钟，完成后用同一判据校验。

### 3.1 先取出安装包（仅当本轮 Release 需要附资产）

```powershell
$Repo   = 'D:\My Project\MDplus'
$Backup = 'D:\My Project\_backup\MDplus\2026-10-29'
$bundle = Join-Path $Repo 'src-tauri\target\release\bundle'
if (Test-Path -LiteralPath $bundle) {
  $dest = Join-Path $Backup 'bundle'
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $pick = @(Get-ChildItem -LiteralPath $bundle -Recurse -File -Include *.msi,*.exe |
            Where-Object { $_.Name -like 'MDPlus_0.2.4_*' })
  if ($pick.Count -ne 2) { throw "期望 0.2.4 的 MSI+NSIS 各一个，实际 $($pick.Count) 个：$($pick.Name -join ', ')" }
  $pick | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
    $h = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    '{0,-42} {1,8} MB  sha256={2}' -f $_.Name, [math]::Round($_.Length/1MB,1), $h.Substring(0,16)
  }
} else {
  '未找到 bundle：本轮没有可附的安装包'
}
```

**为什么必须在第 4 步之前做**：`bundle` 位于 `src-tauri\target` 内部，第 4 步删除 target 后安装包即丢失，且重建需 10-30 分钟。

**通过判据**：得到 2 个安装包（MSI + NSIS）及各自 SHA256；取不到就在 Release 说明里写明「本轮不提供安装包」。

### 3.2 回滚演练（删除前必须做一次）

用已生成的归档证明「删了能恢复」，结果记入 `cleanup-log` 第 6 节：

```powershell
$Backup  = 'D:\My Project\_backup\MDplus\2026-10-29'
$drill   = Join-Path $Backup 'drill'
$archive = Join-Path $Backup 'fn-key-shortcuts.diff.tar.gz'
New-Item -ItemType Directory -Force -Path $drill | Out-Null
tar -xzf $archive -C $drill
Get-ChildItem -LiteralPath $drill -Recurse -File | Select-Object Name, Length
Remove-Item -LiteralPath $drill -Recurse -Force
'演练完成：归档可解包，条目数与源一致'
```

**通过判据**：解包文件数与 `archive-index.csv` 的 `Files` 一致，内容可读。

---

## 4. 删除：白名单断言 + 逐条执行

```powershell
$Repo   = 'D:\My Project\MDplus'
$Log    = Join-Path $Repo 'docs\ops\cleanup-2026-10-29.log'
$DryRun = $true          # 先 $true 跑一遍，确认清单无误后改 $false

Set-Location $Repo
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path (Split-Path $Log) | Out-Null

# 白名单：任何命中都立即中止（绝对路径前缀匹配，防大小写/分隔符绕过）
$Whitelist = @(
  '.audit\2026-10-29', 'src', 'src-tauri\src', 'src-tauri\Cargo.toml',
  'public', 'package.json', 'CHANGELOG.md', 'docs\ops',
  '.git', '.env', '.env.local', 'node_modules'
)
$wp = $Whitelist | ForEach-Object { (Join-Path $Repo $_).TrimEnd('\') + '\' }

$DeleteTargets = @(
  'dist',
  'src-tauri\target',
  'fn-key-shortcuts.diff'
)
# C08 未定：确认删除时去掉下一行注释
# $DeleteTargets += 'docs\fn-key-shortcuts-plan.md'

function Assert-Safe {
  param([string]$Rel)
  $root = [IO.Path]::GetFullPath($Repo).TrimEnd('\') + '\'
  $full = [IO.Path]::GetFullPath((Join-Path $Repo $Rel))
  if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw "拒绝：越出仓库 $Rel" }
  $fullSlash = $full.TrimEnd('\') + '\'
  foreach ($w in $wp) {
    if ($fullSlash.StartsWith($w, [StringComparison]::OrdinalIgnoreCase)) { throw "拒绝：目标是白名单内部路径 $Rel" }
    if ($w.StartsWith($fullSlash, [StringComparison]::OrdinalIgnoreCase)) { throw "拒绝：目标是白名单祖先 $Rel，会整树删除受保护内容" }
  }
  return $full
}

$before = (Get-PSDrive D).Free
$empty  = Join-Path ([IO.Path]::GetTempPath()) ('mdplus-empty-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $empty | Out-Null
foreach ($rel in $DeleteTargets) {
  $full = Assert-Safe $rel
  if (-not (Test-Path -LiteralPath $full)) { Write-Host "SKIP  不存在：$rel"; continue }
  $stat = Get-ChildItem -LiteralPath $full -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum
  $line = '{0}  DELETE  {1}  files={2}  MB={3}' -f (Get-Date -Format 's'), $rel, $stat.Count, [math]::Round(($stat.Sum/1MB),1)
  if ($DryRun) { Write-Host ('DRYRUN  ' + $line); continue }

  $ok = $false
  try {
    Remove-Item -LiteralPath ('\\?\' + $full) -Recurse -Force -ErrorAction Stop   # \? 绕过 260 字符限制
    $ok = -not (Test-Path -LiteralPath $full)
  } catch { $ok = $false }
  if (-not $ok) {
    # robocopy 原生支持长路径：先把目标镜像成空目录，再删空壳
    robocopy $empty $full /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    Remove-Item -LiteralPath ('\\?\' + $full) -Recurse -Force -ErrorAction SilentlyContinue
    $ok = -not (Test-Path -LiteralPath $full)
  }
  if (-not $ok) { throw "删除未完成：$rel（已中止，未写日志）" }   # 失败绝不写成功日志
  Add-Content -LiteralPath $Log -Value $line -Encoding utf8
  Write-Host ('DONE    ' + $line)
}
Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue
Write-Output ('reclaimed: {0} GB' -f [math]::Round(((Get-PSDrive D).Free - $before)/1GB, 2))
```

**预期输出（`$DryRun = $true`）**

```text
DRYRUN  2026-10-29T..:..:..  DELETE  dist  files=127  MB=5.1
DRYRUN  2026-10-29T..:..:..  DELETE  src-tauri\target  files=24551  MB=16177.6
DRYRUN  2026-10-29T..:..:..  DELETE  fn-key-shortcuts.diff  files=1  MB=0.1
reclaimed: 0.00 GB
```

**预期输出（`$DryRun = $false`）**

```text
DONE    2026-10-29T..:..:..  DELETE  dist  files=127  MB=5.1
DONE    2026-10-29T..:..:..  DELETE  src-tauri\target  files=24551  MB=16177.6
DONE    2026-10-29T..:..:..  DELETE  fn-key-shortcuts.diff  files=1  MB=0.1
reclaimed: ~16.18 GB
```

**通过判据**：三条均为 `DONE`，`reclaimed` ≥ 16 GB；白名单命中时脚本会 `throw` 中止（这是设计行为，不要绕过）。
**注意**：删除 `src-tauri\target` 后首次 `npm run tauri:build` 为全量编译（10-30 分钟），发布前请预留时间。

---

## 5. 校验：残留为 0、仓库干净、白名单未变

```powershell
$Repo = 'D:\My Project\MDplus'
$Log  = Join-Path $Repo 'docs\ops\cleanup-2026-10-29.log'
Set-Location $Repo
$ErrorActionPreference = 'Stop'

# 5.1 残留检查：必须全部 False
'5.1 残留（期望全部 False）'
foreach ($rel in @('dist', 'src-tauri\target', 'fn-key-shortcuts.diff')) {
  '{0,-28} exists={1}' -f $rel, (Test-Path -LiteralPath (Join-Path $Repo $rel))
}

# 5.2 保护对象未被触碰：指纹应与清理前一致
'5.2 保护对象指纹'
$Protect = @('src', 'src-tauri\src', 'public', 'package.json', 'CHANGELOG.md', '.audit\2026-10-29')
foreach ($rel in $Protect) {
  $full  = Join-Path $Repo $rel
  $item  = Get-Item -LiteralPath $full
  $files = @(Get-ChildItem -LiteralPath $full -Recurse -File -Force -ErrorAction SilentlyContinue)
  if (-not $item.PSIsContainer) { $files = @($item) }
  $text  = ($files | ForEach-Object { $_.FullName.Substring($Repo.Length+1) + '|' + $_.Length } | Sort-Object) -join "`n"
  $hash  = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($text))
  $sha   = [BitConverter]::ToString($hash).Replace('-','')
  '{0,-28} files={1,-6} sha256={2}' -f $rel, $files.Count, $sha.Substring(0,16)
}

# 5.3 仓库干净度
'5.3 git status'
git status --porcelain=v1 -b
'5.4 仓库完整性'
git fsck --connectivity-only --no-progress
'5.5 磁盘'
Get-PSDrive D | Select-Object Name, @{ n='FreeGB'; e={ [math]::Round($_.Free/1GB,1) } }
'5.6 日志尾部'
Get-Content -LiteralPath $Log -Tail 10
```

**预期输出**

```text
5.1 残留（期望全部 False）
dist                         exists=False
src-tauri\target             exists=False
fn-key-shortcuts.diff        exists=False
5.2 保护对象指纹
src                          files=...  sha256=...
src-tauri\src                files=...  sha256=...
public                       files=...  sha256=...
package.json                 files=1    sha256=...
CHANGELOG.md                 files=1    sha256=...
.audit\2026-10-29            files=1130 sha256=...
5.3 git status
## agent/bootstrap...origin/agent/bootstrap
?? .audit/
?? docs/fn-key-shortcuts-plan.md
?? docs/ops/
5.4 仓库完整性
（无输出）
```

**通过判据**：5.1 全 False；5.2 中 `.audit\2026-10-29` 仍为 1130 个文件；5.3 仅剩预期未跟踪项；5.4 无输出；5.5 可用空间比第 1 步增加约 16 GB。

---

## 6. 记录：清理日志与归档索引

把第 4 步 `cleanup-2026-10-29.log` 的原始行粘进 `docs/ops/cleanup-log-2026-10-29.md` 的「清理记录」表，并复核归档哈希：

```powershell
$Backup = 'D:\My Project\_backup\MDplus\2026-10-29'
Import-Csv (Join-Path $Backup 'archive-index.csv') | Format-Table Path,Files,SizeMB,SHA256 -AutoSize | Out-String -Width 200
Get-FileHash (Join-Path $Backup 'fn-key-shortcuts.diff.tar.gz') -Algorithm SHA256
```

**预期**：索引 2 行（若含 C01/C02 则 4 行），`SHA256` 为 64 位十六进制，与 `Get-FileHash` 复算一致。

---

## 7. 打标签并发布 Release

> 前置：P1/P2/P6 已确认；第 5 步全部通过。

### 7.1 CHANGELOG 由「候选」转正

编辑 `CHANGELOG.md` 顶部 v0.2.4 段：

1. 标题 `## v0.2.4（候选，2026-10-29）` 改为 `## v0.2.4 (2026-10-29)`（与 v0.2.3 等历史条目风格一致）。
2. 改写「验收与候选说明」中的 `候选安装包尚未签名、未公开发布；本次代码推送不包含安装包，不创建版本标签或 Release。`，例如：
   `已发布 v0.2.4 标签与 GitHub Release；安装包仍未签名，需从 Release 附件下载到本地磁盘后运行。`
3. 保留验收范围与未覆盖项（跨安装器迁移、降级、卸载、ARM64 等），这是发布说明的一部分。

校验：

```powershell
$Repo = 'D:\My Project\MDplus'
Set-Location $Repo
git diff --check
Select-String -Path CHANGELOG.md -Pattern '候选|不创建版本标签' | Select-Object LineNumber, Line
```

**预期**：`git diff --check` 无输出；第二条命令无匹配（或仅剩你决定保留的说明）。

### 7.2 提交记录与文档

```powershell
$Repo = 'D:\My Project\MDplus'
Set-Location $Repo
git add CHANGELOG.md docs/ops .gitignore
git add -f docs/ops/cleanup-2026-10-29.log     # *.log 被 .gitignore 忽略，记录类日志必须 -f 显式入库
if (git diff --cached --quiet) { throw '没有可提交的变更：CHANGELOG 转正与记录是否已保存？' }
git status --short
git commit -m "chore(release): v0.2.4"
$ReleaseCommit = (git rev-parse HEAD).Trim()
$Baseline      = '9a2fae15a26d1b3d15868c6c5be6a18440786d18'
if ($ReleaseCommit -eq $Baseline) { throw "提交未产生，HEAD 仍是基线 $Baseline" }
git show --stat --oneline HEAD
'{0} {1}' -f $ReleaseCommit, (git log -1 --pretty=format:'%h %s')
```

**预期**：`git status --short` 列出的均为本次新增/修改的文件；提交后输出 40 位 SHA 与 `chore(release): v0.2.4`。记下这个 SHA（下称 `$ReleaseCommit`）。

### 7.3 推送分支

```powershell
$Repo = 'D:\My Project\MDplus'
Set-Location $Repo
git push origin agent/bootstrap
git rev-list --left-right --count 'HEAD...@{upstream}'
git rev-parse HEAD
```

**预期**：推送成功；发散计数 `0 0`；`HEAD` = `$ReleaseCommit`。

### 7.4 创建 annotated tag（指向发布提交）

```powershell
$Repo   = 'D:\My Project\MDplus'
$Tag    = 'v0.2.4'
Set-Location $Repo
if (git rev-parse -q --verify "refs/tags/$Tag") { throw "标签已存在：$Tag（如需重打，先按第 8 章 R2 删除）" }
$Commit   = (git rev-parse HEAD).Trim()
$Baseline = '9a2fae15a26d1b3d15868c6c5be6a18440786d18'
if ($Commit -eq $Baseline) { throw 'HEAD 仍是基线提交：CHANGELOG 转正与 docs/ops 记录尚未提交（先做 7.2）' }
if (-not (git show ('{0}:CHANGELOG.md' -f $Commit) | Select-String -SimpleMatch 'v0.2.4 (2026-10-29)')) { throw '提交中的 CHANGELOG 尚未转正' }
if (-not (git ls-tree -r --name-only $Commit -- docs/ops/cleanup-2026-10-29.log)) { throw '提交中缺少清理日志' }

git tag -a $Tag -m "MDPlus $Tag" -m "commit: $Commit"
git rev-list -n 1 $Tag
git cat-file -t $Tag
git show --no-patch --format='%H%n%an <%ae>%n%ad%n%s' $Tag
```

**预期**：`git rev-list -n 1 v0.2.4` 输出 `$ReleaseCommit`；`git cat-file -t` 输出 `tag`（annotated，不是 `commit`）；`git show` 显示 tagger 与说明。

**通过判据**：标签指向的提交 == 7.3 步的 `HEAD`，且该提交包含 CHANGELOG 转正与 `docs/ops` 记录。

### 7.5 推送标签

```powershell
$Repo = 'D:\My Project\MDplus'
$Tag  = 'v0.2.4'
Set-Location $Repo
git push origin "refs/tags/$Tag"
git ls-remote --tags origin $Tag
```

**预期**：`git push` 输出 `[new tag]`；`ls-remote` 返回两行——`refs/tags/v0.2.4`（tag 对象）与 `refs/tags/v0.2.4^{}`（peeled，应等于 `$ReleaseCommit`）。

### 7.6 创建 GitHub Release

说明文件：`docs/ops/release-notes-v0.2.4.md`（本次已一并生成，内容取自 CHANGELOG v0.2.4 段与验收结论）。

```powershell
$Repo  = 'D:\My Project\MDplus'
$Tag   = 'v0.2.4'
$Notes = Join-Path $Repo 'docs\ops\release-notes-v0.2.4.md'
Set-Location $Repo

# 落款日期替换；仍有「待填」则中止，避免把占位符发到公开页面
$today = Get-Date -Format 'yyyy-MM-dd'
$text  = (Get-Content -LiteralPath $Notes -Raw -Encoding utf8).Replace('发布日期：待填', ('发布日期：' + $today))
Set-Content -LiteralPath $Notes -Value $text -Encoding utf8 -NoNewline
if (Select-String -LiteralPath $Notes -Pattern '待填') { throw '说明文件仍有「待填」占位，先补齐再发布' }

gh release create $Tag --verify-tag --title "MDPlus v0.2.4 - 功能键快捷入口与源码撤销" --notes-file $Notes
```

**预期**：输出 `https://github.com/xsuooo/MDplus/releases/tag/v0.2.4`。

### 7.6.1 追加安装包资产（仅当 3.1 取到了安装包）

```powershell
$Repo   = 'D:\My Project\MDplus'
$Tag    = 'v0.2.4'
$Backup = 'D:\My Project\_backup\MDplus\2026-10-29'
Set-Location $Repo
$assets = @(Get-ChildItem -LiteralPath (Join-Path $Backup 'bundle') -Recurse -File -Include *.msi,*.exe |
            Where-Object { $_.Name -like 'MDPlus_0.2.4_*' })
if ($assets.Count -ne 2) { throw "期望 0.2.4 的 2 个资产，实际 $($assets.Count) 个：$($assets.Name -join ', ')" }
$assets | Select-Object Name, @{ n='MB'; e={ [math]::Round($_.Length/1MB,1) } }
gh release upload $Tag $assets.FullName --clobber
gh release view $Tag --json assets --jq '.assets[].name'
```

**预期**：输出 2 个资产文件名。**通过判据**：`gh release view` 的 assets 含 MSI 与 NSIS 各一个，且大小与本地产物一致。

### 7.7 发布后校验

```powershell
$Repo = 'D:\My Project\MDplus'
$Tag  = 'v0.2.4'
Set-Location $Repo
gh release view $Tag --json tagName,name,isDraft,isPrerelease,targetCommitish,url,publishedAt
git rev-list -n 1 $Tag
git status --porcelain=v1 -b
```

**预期**：`isDraft=false`、`isPrerelease=false`、`tagName=v0.2.4`；`git rev-list -n 1` 仍为 `$ReleaseCommit`；工作区干净（`## agent/bootstrap...origin/agent/bootstrap`）。

**发布完成判据**：标签指向正确提交 ✅；Release 非草稿且说明完整（变更、验收、已知限制）✅；清理日志与归档索引已入库 ✅。

---

## 8. 回滚说明

按事故范围从小到大执行；每步后再跑一次第 5 章校验。

| 场景 | 命令 | 校验 |
|------|------|------|
| R1 仅删错文件，未提交 | 从归档解包（见下） | 文件数/大小与清单一致 |
| R2 标签已建未推送 | `git tag -d v0.2.4` | `git tag -l v0.2.4` 无输出 |
| R3 标签已推送、Release 未建 | `git push origin :refs/tags/v0.2.4` 然后 `git tag -d v0.2.4` | `git ls-remote --tags origin v0.2.4` 无输出 |
| R4 Release 已发布 | `gh release delete v0.2.4 --yes --cleanup-tag` 然后 `git tag -d v0.2.4` | `gh release list` 无 v0.2.4 |
| R5 发布提交需撤销 | `git revert --no-edit <sha>` 后推送；**禁止** `reset --hard` 强推（除非仓库所有者书面授权） | `git log --oneline -3` |
| R6 构建产物缺失 | `npm ci` 然后 `npm run build` 然后 `npm run tauri:build` | `dist` 与 `src-tauri/target` 重建完成 |

**R1 恢复单个归档**

```powershell
$Repo    = 'D:\My Project\MDplus'
$Backup  = 'D:\My Project\_backup\MDplus\2026-10-29'
$Archive = Join-Path $Backup 'fn-key-shortcuts.diff.tar.gz'   # 文件名以 archive-index.csv 为准

tar -tzf $Archive | Select-Object -First 5
tar -xzf $Archive -C $Repo
Test-Path (Join-Path $Repo 'fn-key-shortcuts.diff')
```

**预期**：解包前先列出内容确认路径（不得含 `../` 或绝对路径）；解包后 `Test-Path` 为 `True`，大小与清单一致。

**R1 全量恢复（按索引逐条）**

```powershell
$Repo   = 'D:\My Project\MDplus'
$Backup = 'D:\My Project\_backup\MDplus\2026-10-29'
$idx = Import-Csv (Join-Path $Backup 'archive-index.csv')
foreach ($row in $idx) {
  if ((Get-FileHash -LiteralPath $row.Archive -Algorithm SHA256).Hash -ne $row.SHA256) { throw "归档哈希不符：$($row.Archive)" }
  tar -xzf $row.Archive -C $Repo
  if ($LASTEXITCODE -ne 0) { throw "解包失败：$($row.Archive)" }
  $target = Join-Path $Repo $row.Path
  $now    = @(Get-ChildItem -LiteralPath $target -Recurse -File -Force -ErrorAction SilentlyContinue)
  $bytes  = ($now | Measure-Object -Property Length -Sum).Sum
  $ok     = ($now.Count -eq [int]$row.Files) -and ($bytes -eq [int64]$row.Bytes)
  if (-not $ok) { throw "恢复不完整：$($row.Path) files=$($now.Count)/$($row.Files) bytes=$bytes/$($row.Bytes)" }
  '{0,-32} files={1} bytes={2} OK' -f $row.Path, $now.Count, $bytes
}
git -C $Repo status --porcelain=v1
```

**回滚演练要求**：正式删除前，至少对 1 个归档执行一次 R1 恢复演练并在 `cleanup-log` 记录结果（用于证明「被删文件可回滚」）。

**归档保留**：`D:\My Project\_backup\MDplus\2026-10-29\` 至少保留 30 天，或确认 v0.2.4 稳定后再清理。

---

## 9. 风险与注意事项

1. **16.2 GB 删除不可逆（可再生项）**：`src-tauri/target` 不归档，回滚依赖重新编译。若本机 Rust/MSVC/WebView2 工具链不完整，删除前先确认 `npm run tauri:build` 可跑通。
2. **长路径**：`src-tauri/target` 内含超过 260 字符的路径，`Remove-Item` 可能失败；脚本已内置 `cmd /c rd /s /q` 兜底，仍失败则启用系统 `LongPathsEnabled` 后重试。
3. **公开仓库**：`xsuooo/MDplus` 为 public，Release 说明与附件对所有人可见，不得包含本机绝对路径、内网地址、个人信息。
4. **标签不可变**：标签被他人拉取后重打会造成分叉；R2/R3 仅在「无人拉取」时使用，R4 必须先用 `gh release delete` 再删标签。
5. **审计保留期**：本轮不删审计日志。保留期确定为 7 天后，建议按月度窗口固定执行，并以 `docs/ops/cleanup-manifest-<日期>.csv` 作为唯一判据。
6. **未跟踪文档**：`docs/fn-key-shortcuts-plan.md` 默认「待定」；删除前先归档（第 3 步已含）或决定入库。**不要** 在工作区执行 `git clean -fdx`——它会连带删除 `.audit/2026-10-29` 与 `node_modules`。
7. **禁止命令**：本流程不使用 `git clean -fdx`、`git reset --hard` 等无差别命令；删除必须逐条、带白名单断言。
8. **凭据**：`gh` 使用 keyring 中的 token（scope: repo/workflow），不要把 token 写入脚本或日志。
9. **提交身份**：实测 `git config user.email` 目前是模板占位符，第 1 步的自检会直接中止；先改成真实邮箱再发布，否则 public 仓库历史里会永久留下占位符。
10. **日志入库**：`.gitignore` 第 2/3 行的 `logs` 与 `*.log` 会忽略执行日志，第 7.2 步必须 `git add -f`；否则「清理日志已入库」只是错觉。
11. **安装包版本混杂**：`src-tauri\target\release\bundle` 里同时存在 0.2.3 与 0.2.4 的 MSI/NSIS（实测 4 个），上传前必须按 `MDPlus_0.2.4_*` 过滤并断言恰好 2 个，否则 v0.2.4 发布页会挂上旧版本安装包。

---

## 附录 A：清理记录表（粘贴进 `docs/ops/cleanup-log-2026-10-29.md`）

| 序号 | 路径 | 类别 | 文件数 | 大小(MB) | 动作 | 归档 | SHA256(前16) | 时间 | 结果 | 回滚方式 |
|------|------|------|--------|----------|------|------|--------------|------|------|----------|
| C04 | `dist` | Regen | 127 | 5.1 | 删除 | 无 | — | 待填 | 待填 | `npm run build` |
| C05 | `src-tauri\target` | Regen | 24551 | 16177.6 | 删除 | 无 | — | 待填 | 待填 | `npm run tauri:build` |
| C07 | `fn-key-shortcuts.diff` | Patch | 1 | 0.1 | 删除 | tar.gz | 待填 | 待填 | 待填 | 解包归档 |
| C08 | `docs\fn-key-shortcuts-plan.md` | Doc | 1 | 0.0 | 待定 | tar.gz | 待填 | 待填 | 待定 | 解包归档 |

## 附录 B：发布记录表

| 项 | 值 |
|----|----|
| 版本 / 标签 | 0.2.4 / `v0.2.4`（待确认） |
| 发布提交 | 待填（`$ReleaseCommit`） |
| 基线 HEAD | `9a2fae15a26d1b3d15868c6c5be6a18440786d18` |
| 分支 | `agent/bootstrap` |
| 预检结论 | 待填（0 0 divergence / fsck 无输出） |
| 备份位置 | `D:\My Project\_backup\MDplus\2026-10-29\` |
| Release URL | 待填 |
| 执行人 / 复核人 | 待填 / 待填 |
| 备注 | 安装包未签名；已知限制见 release notes |

## 附录 C：一条命令复核

```powershell
$Repo='D:\My Project\MDplus'; $Tag='v0.2.4'
Set-Location $Repo
[pscustomobject]@{
  Head       = (git rev-parse --short HEAD)
  Branch     = (git rev-parse --abbrev-ref HEAD)
  Divergence = (git rev-list --left-right --count 'HEAD...@{upstream}')
  TagCommit  = (git rev-list -n 1 $Tag 2>$null)
  TagType    = (git cat-file -t $Tag 2>$null)
  DirtyFiles = @(git status --porcelain).Count
  FreeGB     = [math]::Round((Get-PSDrive D).Free/1GB,1)
} | Format-List
```
