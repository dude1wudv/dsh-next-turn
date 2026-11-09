# 进度

## 2026-11-09 · Phase 3 开关手感与自动状态（v0.2.1）

用户反馈：点「自动」时启动动画僵硬、容易来回点；输入的时候自动状态老是掉。

1. **点击没反馈 → 反复点**：旧版点完要等下一轮轮询（最长 1.2s）才变色变字，手感像没点上。
   修复：乐观更新（点击立刻切换本地状态）+ POST 后立刻 `refresh()` 拉一次 + 宿主状态追上后清掉乐观值（2s 兜底）；按钮固定 92px 宽，避免「自动」→「自动 3/12」时宽度跳变；背景/文字/圆点加 160ms 过渡。
2. **打字就掉自动**：客户端有一条「草稿非空且与建议不同 → 关自动」的 effect，每敲一个字都会触发；Host 侧还有「手动发消息即关自动」。
   修复：两条都删掉。自动提交本来就只在草稿为空时发生，不会抢用户正在写的内容；开关只由用户点击或安全阀（轮次上限、模型判断无下一步、提交被拒、连续两次同一句）改变。
3. **连点会错乱**：每次点击都立刻发一个 POST，连点时多个请求可能乱序到达，后到的旧请求会把状态打回反方向，看起来像「点了没用」。
   修复：点击只更新乐观状态，POST 防抖 140ms 只发最后一次；目标状态用 ref 读取，同一帧里连点两次也能正确取反。

验证：真实界面里点按钮，标签在 600ms 内变成「自动 0/12」，再点回「自动」；`node test/smoke.mjs` 与 `node test/client-shape.mjs` 全绿。连点验证见下轮。

## 2026-11-09 · Phase 2 三个 bug 修复 + 对标复刻（v0.2.0）

用户反馈的三个问题与根因：

1. **自动按钮和右下角发送/停止按钮重复、打架**
   根因：旧版把「自动」按钮绝对定位在 `overlayAnchor`（`height:0`）的右上角，正好压在 `.GRgSLq_trailing` 的 34×34 发送键上。
   修复：按钮改注册到 `conversation.input.left` 槽位，作为 `.tools` 里的正常 flex 子项（28px 胶囊），彻底离开绝对定位。ghost 仍留在 `conversation.input.overlay`。

2. **原生 placeholder 和 ghost 文字重叠看不清**
   根因：ghost 是另一层绝对定位文字，而原生 `[data-composer-placeholder]` 仍然渲染，两段文字叠在同一位置。
   修复：不猜坐标，直接测量 placeholder 的 `getBoundingClientRect()`，ghost 用同样的 `left/top/width/height` 渲染；显示时给卡片加 `data-next-turn-ghost`，注入的 CSS 把原生 placeholder `visibility:hidden`。placeholder 只在「草稿为空 + 无附件 + 无命令认领」时存在，因此它同时成为「可以显示 ghost」的判据，不再需要轮询草稿内容。位置额外做了卡片边界钳制，绝对定位子元素不会撑大页面滚动区。

3. **一轮没完全结束就调模型生成提示词**
   根因：旧版在 `turn/end` 立刻生成，而 `turn/end` 之后排队消息 / goal 续跑会马上开新一轮，于是上一轮的建议出现在正在运行的轮次里。
   修复：`turn/end` → 等 `settleMs`（600ms）静默期 → 期间 `turn/start` 就取消；生成中遇到 `turn/start` / `user/message` 立刻 abort 并清建议；`error` 轮次不预测；最后一轮不是 assistant 收尾也不预测。

### 对标复刻（来源见 BENCHMARK.md）

- 输出过滤层 + `NONE` 空值契约（dsh-suggest / Open WebUI）：评价类、助手口吻、反问、代码片段、多句、与用户重复的话全部丢弃；被丢弃时返回空建议，不再把 `[debug]` 写进输入框。
- `maxOutputTokens` 默认降到 64，超时 10s（dsh-suggest 的成本纪律）。
- 拒绝通道：`Esc` 忽略、`×` 忽略并中止在途请求（Copilot / dsh-suggest）。
- 自动模式安全阀：轮次上限、模型判断无下一步、提交被拒、连续两次同一句 → 关闭自动；打字/手动发消息**不再**关闭开关（0.2.1 修正）。
- 共享轮询：ghost 与按钮共用一个 per-session store，空闲 1.2s / 生成中 350ms，页面隐藏时不请求。
- 生成中显示半透明预览且 `Tab` 不生效，避免填入半句。

### 验证

- [x] `node test/smoke.mjs`：11 组用例通过（静默期闸门、生成中取消、输出过滤 12 条、自动宽限期、轮次上限、空建议关自动、dismiss 中止、error 轮次跳过、disposed 清理、400 校验）。
- [x] `node --check lib/index.js` / `node --check lib/client.js`。
- [x] 插件目录是符号链接（`~/.dsh/profiles/desktop/node_modules/dsh-next-turn` → 源码目录），改源码后刷新页面即可生效。
- [ ] 真机回归：ghost 与 placeholder 不再重叠、自动按钮不再压发送键、自动模式能连续跑且能停。
- [ ] 用户反馈的「异常滚动」：见下节排查结论。

### 「异常滚动」排查

- 截图里的布局（主区域空白 + 输入框在滚动内容顶部 + 底部露出浅灰文字）对应 DSH 的 **`data-conversation-composer-overlay` 模式**：`.viewArea` 变 `overflow:hidden`、`.composerSeat` 从 `position:sticky` 变成 `position:absolute;bottom:0`。这个属性只有 `dsh-client-ui-trajectory`（轨迹视图）和 `dsh-experimental-client-ui-stats`（统计视图）会设置，不是本插件画的。
- 但插件确实有能力造成同类现象：ghost 是绝对定位子元素，会参与最近滚动容器（`.an3WzG_scrollBody`）的 scrollable overflow。旧版只在挂载时测一次位置，输入框从「首屏居中」切到「底部停靠」时卡片位置变了、尺寸可能不变，ResizeObserver 不触发 → ghost 被画到卡片下方几百像素 → 滚动区被撑大，能一直往下拉。
- 修复三层：① 位置钳制在卡片 `clientWidth/clientHeight` 内，异常值也不会溢出；② 每次渲染后重测（轮询每 1.2s 触发一次渲染，位置变化最迟一轮内纠正）；③ 监听 `scroll`（捕获阶段）+ `resize` + ResizeObserver + MutationObserver。
- 待用户确认：刷新加载新 bundle 后是否仍能滚出空白；若仍在，确认是「会话视图」还是「轨迹/统计视图」。

### 关键文件

- `lib/index.js` — Host（静默期闸门、取消、过滤层、路由、安全阀）
- `lib/client.js` — Client（ghost 测量对齐、工具栏「自动」、Tab/Esc/×、自动提交）
- `cordis.patch.yml` — bundle patch（新增 settleMs / timeoutMs / maxOutputTokens / maxMessageChars）
- `test/smoke.mjs` — Host 行为测试
- `BENCHMARK.md` — 同类插件对标

### 已知坑（新增）

- `overlayAnchor` 只放 overlay 槽位，`height:0`；ghost 的绝对定位子元素会参与祖先滚动区的溢出计算，所以坐标必须钳制在卡片内。
- `.GRgSLq_row` 带 `flex-wrap: wrap`：往 `.tools` 加按钮时注意窄窗口下 `.trailing` 可能换行，按钮宽度要克制（28px 高胶囊）。
- 客户端 bundle 有缓存：改 `lib/client.js` 后要刷新页面；disable/enable 插件或重启 DSH 更可靠。

## 2026-11-09 · Phase 0 骨架 + Phase 1 核心链路验证

### 已验证 ✅

- [x] Host 端逻辑：`node test/smoke.mjs` 通过（路由缓存、turn/end 生成、status/auto、安全阀）。
- [x] 插件安装：`dsh plugin --profile desktop add link:.(本仓库根目录)`，package.json + bundles 自动更新。
- [x] Host 插件加载：`plugin_manager list_plugins` 显示 `include:dsh-next-turn`，fiberPhase active。
- [x] Client 插件加载：探针确认 bundle 加载、apply 执行、槽位注入、组件渲染。
- [x] overlay 渲染：`conversation.input.overlay` 槽位里渲染出「自动」按钮（输入框右上角）。
- [x] 自动模式开关：点击后按钮变成「自动 0/12」，Host 端 `/_dsh/next-turn/auto` 路由生效；再点恢复「自动」。
- [x] **ghost text**：轮次结束后输入框出现浅色建议「继续，看输入框里有没有 ghost 或 debug 标记 · Tab」。
- [x] **Tab 填充**：点击输入框聚焦后按 Tab，输入框 value 变成建议全文。
- [x] Host 路由修复：优先监听 `request/header`（`data.header.config.provider/model`），`generate()` 里用 `routeFromSession()` 从会话日志兜底。

### 待验证 ⏳

- [ ] 自动模式自动提交：已开启自动模式（自动 1/12），但 goal 续跑让输入框立刻 busy，`setDraft` 被只读状态拒绝，没提交成功。已加 `useInput` 的 `phase === 'plain'` 检查（client.js），等输入框空闲再填入并提交；需要重启 DSH 加载最新 client bundle 后验证。
- [ ] 探针清理后的最终 bundle：当前页面仍缓存带探针的旧 bundle，重启 DSH 后加载最新代码（无探针）。

### Round 5 修复

- 自动提交加 `useInput` 的 `phase === 'plain'` 守卫：输入框忙（adjudicating/submitting/sending）时跳过，等回到 plain 再 `setDraft` + `submit`。effect 依赖 `inputPhase`，所以 busy → plain 会重新触发。
- 已知限制：goal 自动续跑会在 `turn/end` 后立刻开始下一轮，输入框空闲窗口很短；自动提交依赖这个窗口，goal 场景下可能被跳过。普通会话（无 goal 续跑）窗口更长。

### Round 2 修复

- Host 端路由来源从 `request/context`（只在模型变化时记录）改为优先监听 `request/header`（每次请求都记录，`data.header.config.provider/model`），并在 `generate()` 里用 `routeFromSession()` 从会话日志兜底扫描。`node test/smoke.mjs` 仍通过。
- 已 disable/enable 重载 Host 插件。client bundle 仍被 DSH 缓存（探针未消失），但功能代码与最新版一致。

### 关键文件

- `lib/index.js` — Host（监听 turn/end、调 `ctx.llm.stream()`、路由、安全阀）
- `lib/client.js` — Client（overlay ghost、Tab、自动模式；探针已移除，但页面缓存旧 bundle）
- `cordis.patch.yml` — bundle patch
- `test/smoke.mjs` — Host 冒烟测试

### 已知坑

- `conversation.input.overlay` 的父容器 `overlayAnchor` 是 `height: 0; position: absolute; inset: 0 0 auto`，所以 overlay 根容器高度为 0；按钮用 `position: absolute; top/right` 浮在卡片顶部，`pointer-events: auto` 才能点击。
- 组件不能在没有建议时 `return null`，否则「自动」按钮也不渲染；根容器必须常驻。
- DSH 的 client bundle 有缓存：改 client.js 后刷新页面不一定加载新代码；disable/enable 插件或重启 DSH 更可靠。
- desktop profile 被 Electron 独占，CLI 无法起独立实例验证；test profile 的 `dsh web` 受 Electron 单实例限制，headless 会卡住。

### 回滚

若重启后 DSH 异常：编辑 `~/.dsh/profiles/desktop/package.json`，删 `dsh-next-turn` 依赖和 bundles 条目，重开 DSH。
