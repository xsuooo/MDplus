---
title: MDPlus 快捷键改造与编辑异常排查
template: doc
lang: zh
subtitle: 开发与测试执行说明 · 2026-10-27
---

## A 结论与边界

**F1–F12 已统一支持录制和派发。F11 切换大纲，Ctrl+Shift+E 继续有效。**

- 本次以进入任务时已有的未提交改动为基础，补齐实现与测试。
- 默认 Ctrl 组合不变；已有 Shift、Alt、Meta 组合仍能加载和匹配。
- Windows 的 Win 键对应 `KeyboardEvent.metaKey`，配置使用 `meta`。
- 实体 Fn 不等于 F1–F12。固件未上报的 Fn 不能由网页监听器补造。
- 本次没有增加全局键盘钩子，也不修改 BIOS、注册表或系统快捷键。

这里的“支持”指应用窗口有焦点，且系统把事件交给 WebView。Win+L、Win+D、Alt+Tab 一类系统组合不保证送达。应用不会强行抢占它们。

笔记本先检查 Fn Lock 或厂商的功能键模式。对同一个 F11 键帽，分别测试单按与 Fn+F11。以页面实际收到 `key="F11"` 为准，不以键帽标记为准。

## B 问题定位与证据

| 问题 | 定位与证据 | 修复或结论 |
| --- | --- | --- |
| 裸 F11 无法录制、无法触发 | HEAD 基线的 `parseAccelerator` 要求至少两段；`shortcutFromEvent` 要求存在修饰键 | 两处使用相同的 F1–F12 白名单 |
| “仅 Ctrl、Shift、Win 可用” | HEAD 基线已解析 `alt` 和 `altKey`，也已包含 F1–F12 键名 | 真实限制是“必须带修饰键”，不是缺少 Alt 支持 |
| 录制时看似卡住 | 无效键返回 null 后，界面不退出也不提示 | 给出无效主键、修饰键提示；Esc 取消录制 |
| 增加 F11 导致旧大纲键被替换 | 单动作单字符串无法表示并存键位 | 改为数组，追加而不覆盖 |
| 旧配置升级后仍无 F11 | 已有改动只把旧字符串包成数组，没有补新别名 | 旧有效字符串保留，并补入未被占用的默认功能键 |
| 长按 F11 反复开关 | 派发未检查 `repeat` | 已绑定的重复事件只取消默认行为，不再执行动作 |
| 搜索框 Esc 连带关闭大纲 | 搜索框关闭自身时没有 `preventDefault`；外层仍收到事件 | 搜索、Mermaid、对话框先消费 Esc，大纲尊重 `defaultPrevented` |
| 中文组字时误关面板或撤销 | 组字保护散落，部分入口没有检查 `keyCode=229` | 录制、派发、搜索、对话框、源码、菜单、缩放共用组字判断 |
| 源码粘贴图片后撤销历史丢失 | 已有改动中的图片粘贴直接调用父级 `onChange`，绕过本地历史 | 图片也进入 `handleChange`，保留文本历史与选区 |
| Ctrl+Alt+Z 被误当撤销 | 原 App 撤销特判没有排除 Alt | Alt 组合不走撤销特判；明确的 AltGraph 事件不录制、不派发 |
| F5/F12 修饰组合在 debug 失效 | 已有原生处理仅看 VirtualKey，再调用 `SetHandled(true)` | 删除该旁路；debug/release 共用页面键位表 |

**宿主层是独立检查项，不是所有失效的统一解释。**

WebView2 文档列出查找、刷新、打印、缩放与开发工具加速键。项目在 Windows 初始化时关闭这些浏览器行为，避免与应用动作冲突。这个开关不关闭 Ctrl+C/X/V/A/Z 这类文本编辑加速键。

不能据此断言“全部 F1–F12 都在 JS 之前被吞掉”，也不能断言“旧版 Ctrl+F 在所有机器上都失效”。具体机器须按 H 节记录原生状态与页面事件。

同样，受控 textarea 本身不足以证明撤销损坏。React 支持同步更新的受控 textarea。本次能证实的是已有自建历史中的图片绕路、IME 保护缺失与合并边界问题。

## C 键位映射表

公共条件 **C**：应用获得键盘事件；无应用模态框；非 IME/AltGraph；事件未被消费；修饰键完全匹配。应用动作只在首次 keydown 执行。

| 按键 | 功能 | 触发条件 |
| --- | --- | --- |
| Ctrl+N | 新建文档 | C |
| Ctrl+O | 打开文档 | C |
| Ctrl+S | 保存；新文档转另存为 | C，有活动文档 |
| Ctrl+Shift+S | 另存为 | C，有活动文档 |
| Ctrl+F | 切换应用内查找 | C；查找栏只在活动文档存在时呈现 |
| Ctrl+Shift+E / F11 | 切换大纲 | C；F11 无额外修饰键；两键并存 |
| Ctrl+Shift+M / F2 | 切换源码模式 | C；有活动文档时显示源码区 |
| Ctrl+Shift+H | 导出 HTML | C，有活动文档 |
| Ctrl+Shift+P | 导出 PDF | C，有活动文档 |
| Ctrl+W | 关闭活动标签 | C；未保存时仍走原确认流程 |
| Ctrl+Tab | 下一个标签 | C，有标签 |
| Ctrl+Shift+Tab | 上一个标签 | C，有标签 |
| Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z | 撤销 / 重做 | 富文本由 Milkdown 处理；源码由本地历史处理；不含 Alt、非组字 |
| Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0 | 放大 / 放大 / 缩小 / 重置 | 编辑器区域内，由原缩放监听处理，非组字 |
| Esc | 关闭当前局部层 | 搜索/菜单/对话框优先；录制中只取消录制；非组字 |
| F1、F3–F10、F12 | 可自定义，默认不分配 | 在设置中录制后按 C 触发；包括 F5、F12 |
| Ctrl/Alt/Shift/Meta + 合法主键 | 用户原有或新增绑定 | C；Meta 即 Windows Win；系统保留组合可能不送达 |
| 实体 Fn / FnLock | 不作为独立应用动作 | 若固件不上报，则无法捕获；Fn+F11 产生 F11 时按 F11 处理 |

普通裸字母、数字、空格、Enter、Delete 不允许绑定。仅 Shift+字母的旧绑定不被删除，但设置中会提示输入冲突。它仍可能影响大写输入，建议用户主动改成 Ctrl 组合或功能键。

F5/F12 在桌面版默认不刷新、不打开开发工具。若绑定了应用动作，则执行该动作。开发时使用 Vite 热更新或现有开发工具入口，不再保留抢占页面键位的原生调试旁路。

## D 实现位置与执行顺序

1. 修改 `src/lib/shortcuts.ts` 的共享规则。
   统一规范键名、修饰键顺序、功能键白名单和组字判断。
2. 用 `sanitizeShortcuts` 兼容旧配置。
   保留显式解绑、自定义组合键和数组中的用户选择。
3. 用 `createShortcutIndex` 建立反向索引。
   `src/App.tsx` 在绑定变化时重建，不在每次按键时遍历全表。
4. 在 `ShortcutModal` 的 window 捕获阶段录制。
   普通录制事件被消费；IME/AltGraph 事件原样放行。
5. 在 `App` 的 window 冒泡阶段派发。
   先让局部编辑器处理，再检查模态状态，最后调用 `dispatchShortcut`。
6. 在原生 Windows 初始化中关闭浏览器加速键。
   用 `with_webview` 获取 controller，转换到 `ICoreWebView2Settings3`。
7. 修复所有已识别的局部编辑入口。
   包括搜索、Mermaid、对话框、源码撤销、图片粘贴与缩放。
8. 执行 G 节自动化，再执行 H 节实机清单。

主要代码位置：

| 文件 | 实现要点 |
| --- | --- |
| `src/lib/shortcuts.ts` | `canonicalize`、`shortcutFromEvent`、`createShortcutIndex`、`dispatchShortcut` |
| `src/lib/shortcuts.ts` | `findConflicts`、`conflictReport`、`shortcutWarning`、`sanitizeShortcuts` |
| `src/components/ShortcutModal.tsx` | 追加、单键移除、清除、恢复默认、录制提示 |
| `src/App.tsx` | 模态隔离、编辑器优先、F11/F2 动作派发 |
| `src/components/SourceEditor.tsx` | 文本与图片共用历史；400ms 连续输入合并；选区/输入类型改变时分组 |
| `src/lib/sourcePaste.ts` | 保留异步过期检查，并把插入后的 caret 交给源码组件 |
| `src/lib/useDialogFocus.ts` | IME 下不截获 Esc/Tab，保留焦点循环 |
| `src-tauri/src/lib.rs` | `configure_browser_accelerator_keys` 设置并读回宿主开关 |
| `src-tauri/Cargo.toml` | 复用与 Tauri 传递依赖一致的 `webview2-com 0.38`、`windows-core 0.61` |

原生设置成功时输出 `[mdplus] WebView2 browser accelerator keys enabled=false`。转换失败、设置失败或读回仍为 true 均记录错误。没有日志不能当作设置成功的证据。

## E 监听与冲突规则

```flow
键盘固件 -> Windows: F11 或媒体键
Windows -> WebView2: 未被系统保留的事件
WebView2 -> 录制捕获: 禁用浏览器加速键
录制捕获 -> 局部编辑器: 未处于录制状态
局部编辑器 -> App冒泡: 未被消费
App冒泡 -> 规范化索引: 无模态且非组字
规范化索引 -> 应用动作: 命中且非repeat
```

- 使用 `keydown`，不要依赖已弃用的 `keypress`。
- 用 `event.key` 匹配语义键，`code` 只用于诊断物理键位。
- 规范顺序是 `ctrl+alt+shift+meta+key`，大小写不影响匹配。
- `isComposing`、`key="Process"`、`keyCode=229` 均表示本次不处理。
- 明确的 `getModifierState('AltGraph')` 事件让给输入法或布局输入。
- Ctrl+Alt 本身仍是合法自定义组合，不能全部当成 AltGr 禁用。
- 命中后才调用 `preventDefault`。未命中的事件不拦截。
- 命中且 `repeat=true` 时仍取消默认行为，但不再次执行动作。
- 每个 `addEventListener` 在 effect 清理中对应移除。

**冲突检测分三类，不虚构全系统扫描能力。**

| 类别 | 检测方式 | 处理 |
| --- | --- | --- |
| 应用内部重复键位 | 所有别名规范化后建立反向索引 | 新录制拒绝保存，显示占用动作 |
| 存量重复配置 | `conflictReport` 按动作定义顺序报告 | 第一个动作生效；其他别名不受影响；不静默删除数据 |
| 编辑器/缩放/系统保留键 | `shortcutWarning` 检查已知重叠 | 提示风险，不删除已有 Ctrl/Shift/Meta 绑定 |

已知重叠检查不是完整键盘布局表。Milkdown、系统、厂商驱动或第三方热键软件的占用，仍需实机验证。

不要用 `AcceleratorKeyPressed.SetHandled(true)` 作为“把键交给 JS”的方法。它会消费事件；本实现仅关闭浏览器默认动作，不建立第二套原生动作映射。

## F 迁移与兼容契约

`ShortcutBindings` 从 `Record<Action, string | null>` 迁移为 `Record<Action, string[]>`。存储仍使用原 `shortcuts` 字段。

| 旧值或现值 | 结果 | 契约 |
| --- | --- | --- |
| 字段缺失 | 当前默认数组，避开已占用的新增功能键 | 不抢占其他动作的 F11/F2 |
| `null` 或 `[]` | `[]` | 尊重主动解绑 |
| `save: "ctrl+q"` | `["ctrl+q"]` | 不恢复为 Ctrl+S |
| `toggleOutline: "ctrl+shift+e"` | `["ctrl+shift+e", "f11"]` | 保留旧默认并增加 F11 |
| `toggleOutline: "meta+e"` | `["meta+e", "f11"]` | 保留旧自定义并增加空闲 F11 |
| F11 已归属其他动作 | 不给大纲再追加 F11 | 不抢占已有键位 |
| `toggleOutline: ["meta+e"]` | 原样保留 | 数组表示已迁移，不能重新添加用户移除的键 |
| 数组包含大小写重复项 | 规范化后去重 | 保留第一次出现的顺序 |
| 类型错误或数组全部非法 | 回落默认 | 作为脏数据处理；冲突仍在设置中报告 |

恢复默认使用新数组，不与默认常量共享可变列表。普通修改使用新对象，不原地改变默认键位。

## G 自动化验证与可执行命令

在项目根目录打开 PowerShell。以下 TEMP/TMP 设置只影响当前终端及其子进程，不改变系统设置。

```powershell
Set-Location 'D:\My Project\MDplus'
$tempDir = Join-Path $PWD 'src-tauri\target\shortcut-qa-tmp'
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
$env:TEMP = $tempDir
$env:TMP = $tempDir
npm run check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo check --release --locked --manifest-path src-tauri/Cargo.toml
npm run tauri -- build --no-bundle
git diff --check
```

| 验证项 | 本次结果 | 覆盖范围 |
| --- | --- | --- |
| `npm run check` | 通过：18 个文件、215 个用例 | 类型检查；所有默认键派发；Fn；迁移；冲突；repeat；IME；源码历史 |
| `cargo test --locked` | 通过：15 个 Rust 用例 | 文件、图片与启动行为回归 |
| `cargo fmt --check` / Clippy | 通过 | 原生格式与静态检查 |
| `cargo check --release --locked` | 通过 | release 原生编译检查 |
| `npm run build` | 通过 | 生产前端产物 |
| 桌面无安装包构建 | 通过，生成 `src-tauri/target/release/mdplus.exe` | 原生链接与生产资源嵌入；未构建 MSI/NSIS |
| 浏览器交互冒烟 | 通过的项目见下一段 | 仅页面路径，不代表 Windows 宿主验收 |

浏览器实际操作已验证：

- F11 与 Ctrl+Shift+E 都切换大纲；F2 打开源码。
- 模态框内 F11 不派发；源码撤销/重做有效。
- 搜索 Esc 只关闭搜索；F11 删除后可重新录制。
- 重复 F11 被拒绝；裸 a 有提示；F5 可追加且保留 Ctrl+S。

新增测试文件是 `tests/sourceEditor.test.tsx` 与 `tests/keyboardScopes.test.tsx`。原有快捷键、录制面板和图片粘贴测试也已更新。组件处理器测试不模拟真实 Windows 输入法，其能力边界保留在 H 节。

初次使用默认 `%TEMP%` 时，前端构建和五项 Rust 文件测试报“拒绝访问”。改用项目内临时目录后全部通过。没有修改权限、关闭安全软件或跳过失败用例。

## H Windows 实机验收与排障

使用测试文档与可丢弃配置副本，不用正在编辑的正式文档。浏览器合成事件只能覆盖页面派发；Fn 固件、系统保留键和 WebView2 默认动作必须测试真实键盘输入。

| 编号 | 操作 | 期望与验收证据 |
| --- | --- | --- |
| R01 | 在正式桌面构建中逐条按 C 节原有 12 项组合 | 动作不变；保存、关闭仍走原确认和数据保护流程 |
| R02 | 富文本、源码、工具栏分别按 F11，再按 Ctrl+Shift+E | 大纲逐次开关；不进入全屏；焦点与正文不丢失 |
| R03 | 长按 F11 三秒，再松开重按 | 长按仅切换一次；下一次按下再切换 |
| R04 | 打开新建、快捷键、关闭确认模态框后按 F11 | 不切换大纲；模态内原操作仍可用 |
| R05 | 录制 F1–F12 与 Ctrl+F5、Shift+F11、Meta+F11 | 能送达的键均可录制；不刷新；不能送达的键记录宿主/系统原因 |
| R06 | 把 F11 分配给第二个动作 | 拒绝保存并显示占用者；原动作及旧组合键仍可用 |
| R07 | 导入重复配置 | 提示该键位的实际生效者；其他别名仍能执行 |
| R08 | 分别升级默认、定制、null、空数组配置；重启两次 | 符合 F 节；不丢旧键；不重加已移除的功能键 |
| R09 | 在源码输入、删除、移动光标、粘贴文本和图片，再撤销/重做 | 内容与选区恢复；图片不清空更早历史；新编辑清空 redo |
| R10 | 图片保存尚未结束时输入、撤销、换标签或离开源码 | 过期图片不覆盖当前内容 |
| R11 | 开启中文 IME，按 Enter/Esc/F11/Ctrl+Z；录制中也测试 | 候选词操作优先，不误关层、不切换视图、不录错键 |
| R12 | 大纲与搜索/导出菜单/Mermaid 编辑同时打开，按 Esc | 只处理当前局部层；再次按 Esc 才处理外层 |
| R13 | 富文本执行 Ctrl+C/X/V/A/Z/Y/B/I | 剪贴板、选区、历史与格式行为不回归 |
| R14 | 使用 AltGr 布局输入，再测试普通 Ctrl+Alt 自定义组合 | AltGraph 输入不触发命令；普通 Ctrl+Alt 仍可用 |
| R15 | 原有 Win/Meta 与 Shift 定制逐项测试 | 已送达的事件匹配不变；系统保留键不承诺抢占 |
| R16 | 未绑定 F5/F12 时按 F5/F12/Ctrl+R | 桌面版不意外重载或打开开发工具；未保存正文仍在 |
| R17 | 编辑器内 Ctrl+=、Ctrl+-、Ctrl+0 和 Ctrl+滚轮 | 原字号缩放有效；页面不被宿主重复缩放 |
| R18 | 切换 Fn Lock；对比内置键盘与外接键盘 | 记录 key/code；能产生 F11 的模式执行大纲动作 |
| R19 | 窗口失焦、最小化时按 F11 | MDPlus 不接管其它应用的键盘输入 |
| R20 | 用上下文菜单或辅助输入执行源码撤销；切换编辑模式 | 人工核对与本地历史的兼容性；此项本次未自动验证 |

### 定位某一台机器的失效层

1. 使用测试文档，在 DevTools 控制台安装下面的临时监听。
2. 按目标键，比较 capture 与 bubble 的日志。
3. 若无 capture，检查 Fn Lock、系统保留键和宿主设置。
4. 若有 capture 但无 bubble，检查局部监听的传播控制。
5. 若 bubble 显示 defaultPrevented，检查哪个编辑器已消费事件。
6. 若事件可用但无动作，检查规范键位、模态状态和冲突报告。
7. 测试后调用 `stopShortcutProbe()`，不要在正式文档上长期记录键盘。

```javascript
window.stopShortcutProbe?.();
const disposers = [true, false].map((capture) => {
  const handler = (e) => console.table([{
    phase: capture ? 'capture' : 'bubble', key: e.key, code: e.code,
    ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey,
    altGraph: e.getModifierState('AltGraph'), composing: e.isComposing,
    keyCode: e.keyCode, repeat: e.repeat, prevented: e.defaultPrevented,
    target: e.target?.tagName,
  }]);
  window.addEventListener('keydown', handler, capture);
  return () => window.removeEventListener('keydown', handler, capture);
});
window.stopShortcutProbe = () => disposers.forEach((dispose) => dispose());
```

原生层确认读回日志 `enabled=false`，并测试 Ctrl+F/F5/F12。不要把浏览器页面通过、构建成功或未出现错误日志当作宿主键盘路径通过。

### 资料与未覆盖范围

- W3C《UI Events KeyboardEvent key Values》：Fn/FnLock 与标准键名。
  https://www.w3.org/TR/uievents-key/
- Microsoft《ICoreWebView2Settings3》：浏览器加速键与文本编辑键的区别。
  https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2settings3
- Microsoft《ICoreWebView2AcceleratorKeyPressedEventArgs2》：浏览器默认动作与事件处理的区别。
  https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2acceleratorkeypressedeventargs2
- Tauri 原生 WebView 接口：`with_webview` 与 Windows `controller()`。
  https://docs.rs/tauri/latest/tauri/webview/struct.PlatformWebview.html
- React textarea 文档：受控文本区需要同步更新值。
  https://react.dev/reference/react-dom/components/textarea

尚未验证：真实 Fn 固件、Windows 系统保留键、真实 IME、桌面宿主按键路径、MSI/NSIS 安装升级、辅助输入/上下文菜单撤销。源码历史仍按组件实例保存，切换编辑模式不会与 Milkdown 共享撤销栈；本次未重构跨模式历史。
