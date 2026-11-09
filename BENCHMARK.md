# dsh-next-turn 同类开源项目对标（BENCHMARK）

> 调研日期：2026-11-09
> 对象：`apps/dsh-next-turn`（DSH 插件：每轮结束后预测用户下一句，ghost text 显示在输入框，Tab 填入；「自动」开关开启后每轮自动填入并提交，默认最多 12 轮）
> 方法：只读官方文档 / 源码 README / 官方仓库，不凭印象。凡是第三方逆向或社区推测的结论，文中会显式标注，不与官方文档混用。

---

## 0. 一句话结论

**最该抄的不是 ChatGPT，而是同宿主上的 `dsh-suggest`。** 它和 dsh-next-turn 是同一件事的两个实现，跑在同一个 DSH 0.2.x、同一批槽位和路由上，已经把「成本控制（64 token + 复用主请求前缀，实测约 93% 上下文缓存命中）」「输出过滤（丢弃问句/助手口吻/评价类）」「拒绝通道（Esc / ×）」「设置开关（`settings.general.item`）」四件事做完了。其次是 Open WebUI：它把「什么时候该显示 ghost」写成了明确规则——**只在输入框为空、且最后一条是已完成的回复时显示，模型一开始生成就消失**，这正好是 Lead 正在修的「ghost 与 placeholder 重叠」的根因级答案。

---

## 1. 对比表

| 项目 | 功能点 | 实现要点 | 链接 |
| --- | --- | --- | --- |
| **dsh-suggest**（DSH 同类插件，npm `dsh-suggest` 0.3.0） | 每轮结束后预测下一句，输入框上方提示条，Tab 填入 | Host 提供远程方法 `dshSuggest.suggest({ sessionId })`：**原样复用会话最近一次请求的请求头、消息历史、工具定义和 `toolHistory`**，只在末尾追加一条预测指令，再用同一模型请求一次；最多输出 **64 token**、最低推理强度；请求前缀与主对话逐字一致，**实测约 93% 输入 token 命中上下文缓存**；不写会话日志。过滤层先去掉「建议：」前缀/引号/标签，再丢弃空回复、评价类（谢谢、不错）、助手口吻（我来、让我）、问句、多句话、超长或带格式的内容。Client 挂 `conversation.input.overlay` slot，看到一轮回复结束时**只请求一次**；Tab 用 `ctx.shortcuts.observeFixedInput` 截获；设置项挂 `settings.general.item` slot，`enabled` 是 volatile 配置，切换立即生效 | [github.com/dinjufen/dsh-suggest](https://github.com/dinjufen/dsh-suggest) |
| **dsh-codex-composer**（DSH 同类插件） | 空草稿按 Tab 生成「下一步 prompt」，↑/↓ 召回历史 | 只在草稿为空时按 Tab 才 `POST /codex-composer/suggest`；Host 读当前 Session 最近 user/assistant 消息（**最多 14 条、总量约 20k 字符**），用会话实际模型路由生成一条；生成期间底部显示「正在生成下一步建议…」；结果**只写进输入框、不自动发送**；**只请求一次，重复按 Tab 不会并发**；输入、切会话、按 Esc、关插件都会取消；`/`、`@` 菜单打开时 Tab 归菜单；只处理主 composer，用 `setDraft()` 写草稿、不碰 Lexical DOM | [dshpluginhub.ai/zh/plugins/dsh-codex-composer](https://dshpluginhub.ai/zh/plugins/dsh-codex-composer) |
| **Open WebUI — Follow-Up Prompts** | 回复下方可点击 chips + 输入框内 Tab ghost text | chips 显示在回复下方；**「回复结束时，第一条 follow-up 同时以灰色 ghost text 出现在空的消息框里，按 Tab 写入输入框」**；显示条件被明确限定为「**只在输入框为空、且最后一条消息是已完成的回复时显示；模型一开始生成就消失**」；用户开始输入任何内容即消失。三档开关：管理员 `Follow Up Generation` 总开关、用户 `Follow-Up Auto-Generation`、`Keep Follow-Up Prompts in Chat`（默认关）、`Insert Follow-Up Prompt to Input`（默认关 = 点击直接发送） | [docs.openwebui.com/…/follow-up-prompts](https://docs.openwebui.com/features/chat-conversations/chat-features/follow-up-prompts/) |
| **Open WebUI — 默认 follow-up prompt 模板** | 一次生成 3–5 条、按有用度排序、首条进输入框 | 内置模板结构为 `### Task / ### Guidelines / ### Output / ### Chat History`，输出 `{"follow_ups": ["…"]}`；关键约束：**从用户视角写给助手、匹配用户的语言与简洁度、按有用度和可能性排序（最强的排第一，第一条出现在空输入框）、每条 <400 字符、不要重复已完成的工作、不要编造用户事实或授权**；历史注入 `{{MESSAGES:END:5}}`，内置模板实际收到「首条 user 消息 + 最后 4 条」，每条截到 1000 字符；**重复项和超过 400 字符的建议被丢弃，最多显示 5 条** | [docs.openwebui.com/reference/env-configuration](https://docs.openwebui.com/reference/env-configuration/)（`DEFAULT_FOLLOW_UP_GENERATION_PROMPT_TEMPLATE`） |
| **Open WebUI — Task Models** | 后台小调用与主对话分离、可换小模型、可单独关 | `TASK_MODEL`（本地连接）/`TASK_MODEL_EXTERNAL`（非本地连接），**默认都是 Current Model**；`TASK_MODEL_PARAMS` 统一给所有后台请求设 `max_tokens`/`temperature`；未设时后台请求默认按 **1000 输出 token** 封顶；每个后台任务（标题、标签、follow-up、autocomplete、检索改写等）都有独立开关和环境变量 | [docs.openwebui.com/…/task-models](https://docs.openwebui.com/features/administration/task-models/) |
| **Open WebUI — Autocomplete** | 输入时 inline 补全（非 follow-up） | 模板要求「**不确定就返回 `{ "text": "" }`**」，即把「没有建议」做成模型可显式表达的输出契约，而不是靠后处理猜 | [docs.openwebui.com/reference/env-configuration](https://docs.openwebui.com/reference/env-configuration/)（`DEFAULT_AUTOCOMPLETE_GENERATION_PROMPT_TEMPLATE`） |
| **GitHub Copilot — ghost text** | inline 建议的完整键盘语义 | 暗淡 ghost text；**Tab 全量接受、Esc 关闭**；**Accept Word = `Ctrl+→` 逐词接受**；`Accept Line` 需自定义绑定 `editor.action.inlineSuggest.acceptNextLine`；**`Alt+]` / `Alt+[` 在候选建议间切换**；悬停出现管理工具条 | [learn.microsoft.com/…/code-completion-features](https://learn.microsoft.com/en-us/training/modules/get-started-github-copilot/8-examine-github-copilot-code-completion-features)、[vscode-docs ai-powered-suggestions.md](https://github.com/microsoft/vscode-docs/blob/main/docs/editing/ai-powered-suggestions.md) |
| **Cursor — Tab** | inline 建议的接受/拒绝/部分接受 | **Tab 接受全部、Esc 拒绝（或继续打字即消失）**；**`Cmd+→`（Win/Linux `Ctrl+→`）逐词接受**；建议以光标前方的灰色文字呈现；接受后再按 Tab 会预测下一个编辑位置并跳转 | [cursor.com/help/ai-features/tab](https://cursor.com/help/ai-features/tab.md) |
| **ChatGPT — suggested follow-ups** | 回复后的建议追问 | 官方在设置里有 **`Show follow up suggestions in chats`** 开关；社区长期反馈这类建议「像被钓着继续聊」，要求可关闭——**这是「默认开 + 必须能一键关」的直接证据** | [OpenAI 社区讨论帖](https://community.openai.com/t/feature-request-setting-to-disable-follow-up-suggestions/1396688/16)、[设置项报道](https://tech.yahoo.com/ai/articles/one-phrase-chatgpt-drove-nuts-210000279.html)、[Continuation prompt strategy 讨论](https://community.openai.com/t/continuation-prompt-strategy/1245113) |
| **Claude Code — `/goal`** | 朝完成条件自驱续跑 | 用 `/goal` 设完成条件后，**每回合结束由一个模型检查条件是否满足**；未满足就自动开始下一回合而不是把控制权交回；**条件满足 / 模型判断不可能达成 / 回合因需修复的错误失败时，目标自动清除**；文档明确「自动模式只在单个回合内批准工具调用，**不会开始新回合**」 | [code.claude.com/docs/zh-TW/goal](https://code.claude.com/docs/zh-TW/goal) |
| **Claude Code — `/loop`** | 按间隔重复跑 prompt | 固定间隔或让模型自选间隔；**自驱动循环在等待下一轮时按 Esc 停止**（`Ctrl+C` 在空闲时也可），会给出 `Pending wakeup cancelled` 提示；模型可调 `ScheduleWakeup` 带 `stop: true` 主动结束；**调度只在两轮之间触发，不打断正在进行的回复——「如果 Claude 忙，到点的任务等当前回合结束」**；循环 7 天后自动过期 | [code.claude.com/docs/en/scheduled-tasks](https://code.claude.com/docs/en/scheduled-tasks) |
| **Claude Code — prompt suggestion**（⚠️ 社区逆向分析，**非官方文档**，仅作设计参考） | 回合结束后的下一步建议 | 用**小快模型（Haiku）**；1–3 条、每条 2–8 词；匹配用户沟通风格；优先可执行请求而非问句；**不推荐助手刚做完的事**；过滤：与最近执行过的命令去重、过滤彼此过于相似的建议、去掉引用刚完成工作的建议、**上限 3 条**；回合完成后异步触发、不阻塞回复；以可点击 chips 呈现 | [github.com/Leonxlnx/agentic-ai-prompt-research/…/30_prompt_suggestion.md](https://github.com/Leonxlnx/agentic-ai-prompt-research/blob/main/prompts/30_prompt_suggestion.md) |
| **aider** | 全自动确认 | `--yes-always`（环境变量 `AIDER_YES_ALWAYS`）语义为「对所有确认一律回答 yes」，**文档未给默认开启，需显式指定**；另有 `--auto-test`、`--auto-lint` 等独立开关，`--cache-prompts` 默认 False | [aider.chat/docs/config/options.html](https://aider.chat/docs/config/options.html) |
| **AutoGPT** | 连续自动执行的安全阀 | 交互式确认分三档：`y` 单次授权、**`y -N` 连续授权 N 次**、`--continuous` 完全无人值守；文档对 continuous mode 明确警告「**NOT recommended. It is potentially dangerous and may cause your AI to run forever or carry out actions you would not usually authorize**」，退出方式为 `Ctrl+C` | [AutoGPT docs/usage.md](https://github.com/Significant-Gravitas/AutoGPT/blob/ae31dd4bb14404734eb7069aa7c96ad8ce1a97ae/docs/usage.md) |

---

## 2. 三栏结论

### 2.1 dsh-next-turn 已有

对照 `lib/index.js`、`lib/client.js` 现状：

- **轮次结束后预测**：监听 `session/event` 的 `turn/end` 触发 `generate()`。
- **复用会话当前模型路由**：从 `request/header`、`request/context` 事件缓存 `{provider, model}`，并有 `routeFromSession()` 用 `snapshotEvents()` 兜底历史会话。
- **ghost text + Tab 填入**：`conversation.input.overlay` slot 内绝对定位渲染，`document` 捕获阶段监听 Tab，仅空输入框生效。
- **只在空输入框显示**：`draftIsEmpty()` + 400ms 轮询。
- **自动模式 + 轮次上限**：`maxAutoTurns`（默认 12），`turn/end` 时累加、到顶自动关；UI 显示 `自动 n/12`。
- **同源路由 + 鉴权**：`/_dsh/next-turn/status`、`/_dsh/next-turn/auto`，走 `connection.requestRejection()` 的 origin fence。
- **按 session 隔离**：建议与自动状态都是 `Map<sessionId, …>`。
- **不写会话日志**：建议走 `ctx.llm.stream()` 辅助通道，不产生 `user/message` 或 `assistant/message`。

### 2.2 缺失（按严重度）

| 缺失项 | 现状证据 | 后果 |
| --- | --- | --- |
| **输出过滤层** | `index.js` 只有 `text.trim().slice(0, maxSuggestionChars)` | 模型返回问句、助手口吻（「我来…」）、评价类（「好的」）、带引号/前缀的内容会原样变成 ghost |
| **`[debug]` 字符串泄漏进 ghost** | `index.js` 三处 `suggestions.set(…, { suggestion: '[debug] no route' / '[debug] no messages' / '[debug] …error' })`，而 client 无条件渲染 `state.suggestion` | 路由或消息缺失时，用户输入框里出现 `[debug] no route` 这种文字 |
| **拒绝通道** | 无 Esc、无 × 关闭 | 不想要的建议只能等下一轮覆盖 |
| **生成中状态** | 无 | 用户不知道 Tab 为什么没反应（dsh-codex-composer 有「正在生成下一步建议…」） |
| **全链路取消** | 只有 15s 超时 `AbortController` | 新轮开始、用户开始打字、切会话、关插件时旧请求仍在跑并计费 |
| **token 上限 / 推理强度** | `llm.stream()` 未传 `maxOutputTokens` / reasoning 参数 | 每轮一次不封顶的模型调用；自动 12 轮时成本不可控 |
| **前缀缓存复用** | `buildInput()` 把 12 条消息拍平成**一个 user 消息**，system prompt 另置 | 请求前缀与主对话不一致，上下文缓存命中率≈0（dsh-suggest 实测 93%） |
| **多候选** | 只存一条 `suggestion` | 单条命中率低，没有备选 |
| **UI 设置开关** | 只有 `config.enabled`（加载时读一次） | 用户无法在设置里关掉，只能卸载插件 |
| **自动模式「用户介入即暂停」** | 只在 `turn/end` 累加轮次 | 用户一旦手动插话，自动模式还在跑，会跟用户抢输入框 |
| **建议去重** | 无 | 可能反复建议刚做过的事（Claude Code 逆向分析里明确要过滤） |
| **事件驱动** | client `setInterval(load, 1500)` 永久轮询 | 空闲时也在打路由；建议最多延迟 1.5s 才出现 |

### 2.3 可抄的具体做法

1. **Open WebUI 的显示条件（直接解掉 ghost/placeholder 重叠）**：ghost 只在「输入框为空 **且** 最后一条消息是已完成的回复 **且** 模型没在生成」时显示；用户一打字、模型一开始生成就消失。
2. **Open WebUI 的 prompt 模板骨架**：`### Task / ### Guidelines / ### Output(JSON) / ### Chat History`，输出 `{"follow_ups": [...]}`，硬约束「每条 <400 字符、按有用度排序、首条进空输入框、不重复已完成工作、不编造用户事实」。
3. **Open WebUI 的空值契约**：让模型可以显式返回空（autocomplete 模板里是 `{ "text": "" }`），而不是靠后处理猜「这句是不是没建议」。
4. **dsh-suggest 的过滤规则清单**：去前缀/引号/标签 → 丢弃空、评价类、助手口吻、问句、多句、超长、带格式。
5. **dsh-suggest 的成本三件套**：`maxOutputTokens: 64` + 最低推理强度 + **原样复用主请求前缀**（缓存命中）。
6. **dsh-suggest 的槽位用法**：`conversation.input.overlay` 放提示条、`settings.general.item` 放设置行、`enabled` 用 volatile 配置实现热切换。
7. **dsh-codex-composer 的请求纪律**：只请求一次、重复按键不并发、输入/切会话/Esc/关插件即取消、结果只写草稿不自动发送。
8. **Copilot / Cursor 的键盘语义**：Tab 全接受、Esc 拒绝、`Ctrl+→` 逐词接受、`Alt+]`/`Alt+[` 切候选。
9. **AutoGPT 的安全阀文案与档位**：`y` / `y -N` / continuous 三档，continuous 明确警告「可能永远跑下去」。
10. **Claude Code `/loop` 的调度纪律**：**只在两轮之间触发，绝不打断正在进行的回复**；Esc 可随时停；有自动过期。

---

## 3. 按性价比排序的改进建议

> 排序依据：收益 ÷ 改动成本。「Lead 正在修」的项仍列出，但补充对标依据，避免改法跑偏。

### 建议 1（成本：小）加输出过滤层 + 空值契约，顺手堵掉 `[debug]` 泄漏

- **解决什么问题**：ghost 里出现问句、助手口吻、评价类废话、带引号/前缀的脏文本；以及 `[debug] no route` 这类调试串直接显示给用户。
- **具体怎么实现**：
  1. 在 `lib/index.js` 新增纯函数 `sanitizeSuggestion(raw)`，返回 `''` 表示「本轮无建议」。规则照抄 dsh-suggest 的过滤清单：先 `trim`，去掉开头的「建议：」「下一句：」等前缀、成对引号、`<tag>`；再逐条丢弃——空串、评价类（`谢谢|不错|好的|可以`）、助手口吻（`我来|让我|我可以|需要我`）、问句（结尾 `？/?` 或含 `要不要|是否`）、多句（含 2 个以上句末标点）、超长（> `maxSuggestionChars`）、带 markdown/代码块。
  2. `generate()` 末尾改成 `const suggestion = sanitizeSuggestion(text)`；`sanitizeSuggestion` 返回 `''` 时仍写入 `{ suggestion: '', ts }`（表示「本轮已算过、确实没有建议」），client 自然不显示 ghost。
  3. 三处 `[debug]` 改成 `ctx.logger?.debug?.(…)`，**不再写进 `suggestions`**；确实要排障时用 `config.debug` 控制，且 debug 文本走独立字段（如 `debugText`），client 不渲染。
  4. `SYSTEM_PROMPT` 补一句「如果没有明显的下一步，只输出 `NONE`」，然后 `sanitizeSuggestion` 把 `NONE` 归一成 `''`——即 Open WebUI 的显式空值契约。
- **参考**：[dsh-suggest 过滤层](https://github.com/dinjufen/dsh-suggest)、[Open WebUI autocomplete 的 `{ "text": "" }` 契约](https://docs.openwebui.com/reference/env-configuration/)

### 建议 2（成本：小）生成时机与全链路取消

- **解决什么问题**：Lead 已知的「生成太早」；以及新轮开始/用户打字/切会话后，旧请求还在跑、还在计费、回来还可能覆盖新建议。
- **具体怎么实现**：
  1. 触发点从「`turn/end` 立即调」改为「整轮完全结束后调」——Lead 正在处理；对标依据是 Open WebUI 的「最后一条消息是**已完成的回复**」和 Claude Code `/loop` 的「**只在两轮之间触发，不打断正在进行的回复**」。
  2. 在 `lib/index.js` 把 `AbortController` 从局部变量提升到 `const controllers = new Map()`（key 为 `sessionId`）；`generate()` 开头先 `controllers.get(session.id)?.abort()` 再建新的。
  3. 在 `ctx.on('session/event')` 里，遇到 `turn/start`（或等价的「新一轮开始」事件）时 `controllers.get(session.id)?.abort()` 并 `suggestions.delete(session.id)`——旧建议立刻失效。
  4. `generating` Set 已有，保留；再加一层「同一 session 只保留最新一次请求」的序号（`seq`），回来时 `if (seq !== latestSeq.get(session.id)) return`，防止旧结果覆盖新结果。
- **参考**：[Open WebUI follow-up 显示条件](https://docs.openwebui.com/features/chat-conversations/chat-features/follow-up-prompts/)、[Claude Code /loop 调度纪律](https://code.claude.com/docs/en/scheduled-tasks)、[dsh-codex-composer「输入、切会话、Esc 都会取消」](https://dshpluginhub.ai/zh/plugins/dsh-codex-composer)

### 建议 3（成本：小–中）给辅助调用封顶，并复用主请求前缀吃上下文缓存

- **解决什么问题**：每轮一次不封顶的模型调用；自动模式 12 轮时成本不可控；现在把 12 条消息拍平成一个 user 消息，缓存命中率≈0。
- **具体怎么实现**：
  1. `ctx.llm.stream({...})` 补 `maxOutputTokens: 64`（可配置，默认 64）、最低 reasoning effort；超时从 15s 降到 8–10s（64 token 用不到 15s）。
  2. 把 `buildInput(messages)` 从「拼成 `用户：…\n助手：…` 一整段塞进单个 user 消息」改成「**原样透传 `session.deriveMessages()` 的最近 N 条（保留 role 和 content block 结构），末尾追加一条预测指令**」。dsh-suggest 的做法是连请求头、工具定义、`toolHistory` 都原样复用，只追加一条指令，因此前缀与主对话逐字一致，实测约 93% 输入 token 命中缓存。
  3. 若担心工具定义影响，可先只复用 messages + system，用 `config.debug` 打印每次的 `usage`（含 cached tokens）验证命中率，再决定是否加 `includeTools`。
- **参考**：[dsh-suggest「64 token + 最低推理强度 + 93% 缓存命中」](https://github.com/dinjufen/dsh-suggest)、[Open WebUI Task Models「后台请求默认 1000 token 封顶」](https://docs.openwebui.com/features/administration/task-models/)、[Claude Code 逆向分析「用 Haiku 小模型」](https://github.com/Leonxlnx/agentic-ai-prompt-research/blob/main/prompts/30_prompt_suggestion.md)

### 建议 4（成本：小）ghost 与 placeholder、自动按钮与发送键的布局（Lead 正在修，这里给对标依据）

- **解决什么问题**：ghost 用不透明白底遮 placeholder（暗色主题下 `var(--dsw-alias-bg-primary)` 缺失会露白块，且遮住的是「假文字」不是真文字）；自动按钮 `right: 12, top: 8` 正好压在发送/停止键上。
- **具体怎么实现（两条路，推荐 B）**：
  - **A. 留在输入框内**：抄 Open WebUI 的条件显示——只在「输入框空 + 最后一条是已完成回复 + 模型未在生成」时渲染 ghost；同时**不要用背景色去盖 placeholder，而是拿到宿主 placeholder 元素并临时 `visibility: hidden`**（或给输入框加 `data-has-ghost` 属性由 CSS 隐藏 placeholder）。这样不依赖主题色。
  - **B. 移出输入框**：抄 dsh-suggest——在输入框**上方**放一条 suggestion bar（`conversation.input.overlay` 里用 `bottom: 100%` 定位），ghost 与 placeholder 的重叠问题**从结构上消失**，也天然不占发送键的位置。
  - 自动按钮：不要绝对定位在 `right: 12`。放到 suggestion bar 的右端（和提示文字同一行），或输入框卡片下方左侧的状态行；`自动 3/12` 本身就是状态，适合放状态行。
- **参考**：[Open WebUI「只在空输入框 + 已完成回复时显示，模型开始生成即消失」](https://docs.openwebui.com/features/chat-conversations/chat-features/follow-up-prompts/)、[dsh-suggest 用输入框上方提示条](https://github.com/dinjufen/dsh-suggest)

### 建议 5（成本：小）补拒绝通道：Esc 关闭本轮、× 按钮、Tab 后可撤销

- **解决什么问题**：现在没有任何「我不要这条」的表达方式，ghost 会一直挂到下一轮；Tab 填入后用户只能手动删。
- **具体怎么实现**：
  1. `lib/client.js` 加 `const dismissedTs = useRef(0)`；渲染 ghost 的条件加 `state.ts !== dismissedTs.current`。
  2. 在已有的 `document.addEventListener('keydown', …, true)` 里加分支：`event.key === 'Escape'` 且输入框在 `[data-composer-card]` 内 → `dismissedTs.current = state.ts`，并 `event.stopPropagation()` 阻止宿主自己也处理 Esc（若宿主 Esc 有其他语义，则只在有 ghost 时拦截）。
  3. ghost 右侧加一个 `×`（`pointerEvents: 'auto'`，与现有 ghost 的 `pointerEvents: 'none'` 区分），点击同样写 `dismissedTs`。
  4. Tab 填入后，用 `inputActions.setDraft()` 写入——dsh-suggest 说明「这次插入可以撤销」，说明宿主的 `setDraft` 走的是宿主自己的 undo 栈，**不要自己直接改 DOM**，否则撤销失效。
- **参考**：[Cursor「Esc 拒绝或继续打字」](https://cursor.com/help/ai-features/tab.md)、[Copilot「Esc 关闭」](https://learn.microsoft.com/en-us/training/modules/get-started-github-copilot/8-examine-github-copilot-code-completion-features)、[dsh-suggest「× 关闭本轮建议，之后 Tab 恢复原生行为」](https://github.com/dinjufen/dsh-suggest)

### 建议 6（成本：中）自动模式安全阀补强：用户介入即暂停、空建议即停、可见可停

- **解决什么问题**：用户手动插话后自动模式还在跑，会和用户抢输入框；模型判断「没有下一步」时自动模式还在空转；轮次上限只有数字，没有「立刻停」的显式入口。
- **具体怎么实现**：
  1. **用户介入即暂停**：`lib/index.js` 在 `session/event` 里检测到**用户手动发送**（`user/message` 且非本插件 `submit()` 触发）时，`autoState.set(session.id, { auto: false, turns })`。为区分「插件自动提交」与「用户手动发送」，client 在自动提交前调 `POST /_dsh/next-turn/auto` 打一个 `pendingAuto: true` 标记（或带一个自增 `autoSeq`），Host 收到下一条 `user/message` 时若匹配则消费标记、不算用户介入。
  2. **空建议即停**：`generate()` 产出 `''` 时，若 `auto === true` 则直接关掉自动模式并记日志（避免空转 12 轮）。
  3. **可见可停**：`自动 n/12` 按钮点击即停（已有雏形）；再加一行说明文案，抄 AutoGPT 的措辞——continuous 模式「可能永远跑下去、可能做出你不会授权的操作」，明确告诉用户这是无人值守。
  4. **加上限保护**：`maxAutoTurns` 到顶后除了关自动，再 `suggestions.delete(session.id)`，避免最后一条建议还挂着诱导用户继续。
- **参考**：[AutoGPT 三档授权与 continuous 警告](https://github.com/Significant-Gravitas/AutoGPT/blob/ae31dd4bb14404734eb7069aa7c96ad8ce1a97ae/docs/usage.md)、[Claude Code `/loop` 的 Esc 停止与 7 天过期](https://code.claude.com/docs/en/scheduled-tasks)、[Claude Code `/goal` 达成即自动清除](https://code.claude.com/docs/zh-TW/goal)、[aider `--yes-always` 需显式开启](https://aider.chat/docs/config/options.html)

### 建议 7（成本：中）把 1.5s 轮询改成事件驱动（或至少空闲降频）

- **解决什么问题**：`setInterval(load, 1500)` 永久轮询，空闲时也在打同源路由；建议最多延迟 1.5s 才出现，Tab 手感发飘。
- **具体怎么实现（按成本从低到高）**：
  1. **最低成本**：保留轮询但加条件——`document.hidden` 时暂停；连续 N 次返回 `ts` 未变则把间隔从 1.5s 退到 5s，`ts` 一变立刻恢复 1.5s。
  2. **推荐**：client 侧本来就能观察到「一轮回复结束」（dsh-suggest 就是「看到一轮回复结束时请求一次」），在那一刻主动 `fetch` 一次 status，轮询只作为兜底（间隔 10s）。
  3. **更彻底**：Host 侧在 `generate()` 完成后通过已有 `webServer` 推 SSE（`/_dsh/next-turn/events`），client `EventSource` 订阅；这样 0 轮询、0 延迟。
- **参考**：[dsh-suggest「看到一轮回复结束时请求一次」](https://github.com/dinjufen/dsh-suggest)、[dsh-codex-composer「只请求一次，重复按 Tab 不会并发」](https://dshpluginhub.ai/zh/plugins/dsh-codex-composer)

### 建议 8（成本：中–大）多候选 chips + 设置开关（把「单条赌注」变成「三条选项」）

- **解决什么问题**：单条建议命中率低，用户经常看一眼就不想要；且没有 UI 总开关，只能卸载插件。
- **具体怎么实现**：
  1. **Host 输出契约改成数组**：`SYSTEM_PROMPT` 改成 Open WebUI 的骨架，输出 `{"follow_ups": ["…","…","…"]}`；`maxOutputTokens` 提到 160–200（3 条 × 每条约 50 token）。解析失败回退到「整段文本当 1 条」。
  2. **排序即优先级**：Open WebUI 明确「最强的排第一，**第一条出现在空输入框**」。所以 ghost text 仍然只显示 `follow_ups[0]`，Tab 也填第一条——**保持现有 Tab 手感不变**，只是多了备选。
  3. **chips 渲染**：在建议 4 方案 B 的 suggestion bar 里，第一条做 ghost 预览，其余 2 条做成小 chip 排在后面；点击 chip 用 `inputActions.setDraft(chip)` 填入（不自动发送，抄 Open WebUI 的 `Insert Follow-Up Prompt to Input` 默认关的语义是「点击直接发送」，但我们更该用「填入待编辑」这一档）。
  4. **设置开关**：新注册一个 `settings.general.item` slot 渲染开关（dsh-suggest 的做法），写入 `enabled`；把 `enabled` 从「加载时读一次的常量」改成**运行时可变的配置**（dsh-suggest 说它是 volatile 字段，设置服务写进 profile 的 `cordis.patch.yml`，运行中的插件立刻读到新值）。这样不用重启、不用卸载。
  5. **去重**：生成后与「最近 3 条用户实际发送的消息」做相似度过滤（简单做法：归一化后比较前 8 个字符或 Jaccard > 0.6 即丢），避免建议用户刚说过的话。
- **参考**：[Open WebUI 默认模板与「最多 5 条、>400 字符丢弃、首条进输入框」](https://docs.openwebui.com/reference/env-configuration/)、[Open WebUI 三档开关设计](https://docs.openwebui.com/features/chat-conversations/chat-features/follow-up-prompts/)、[dsh-suggest 的 `settings.general.item` + volatile enabled](https://github.com/dinjufen/dsh-suggest)、[Claude Code 逆向分析的「上限 3 条 + 去重 + 过滤相似」](https://github.com/Leonxlnx/agentic-ai-prompt-research/blob/main/prompts/30_prompt_suggestion.md)

---

## 4. 调研可信度说明

- **官方文档（可直接引用为事实）**：Open WebUI 三篇（follow-up、task models、env configuration）、Microsoft Learn 的 Copilot 模块、Cursor 的 Tab 帮助页、Claude Code 的 `/goal` 与 `/loop` 文档、aider options 参考、AutoGPT 的 `docs/usage.md`、两个 DSH 插件的 README。
- **社区材料（仅作设计参考，不当事实）**：Claude Code 的 `SUGGESTION_PROMPT` 是第三方仓库「从源码分析重建」的，**不是 Anthropic 官方文档**，其「Haiku 小模型 / 1–3 条 / 2–8 词 / 上限 3 条」只能作为设计灵感，不能当作官方行为描述。
- **未取到官方一手材料的**：ChatGPT suggested follow-ups 没有找到 OpenAI 官方功能文档，只有设置项报道与社区讨论帖，因此本文只把它当作「用户需要一键关闭」的证据，不描述其内部实现。LobeChat / LibreChat / Cherry Studio 未找到与「下一句预测」等价的一手官方文档（LibreChat 的 `conversation_starters` 是**会话开场预设**，不是每轮结束后的建议，性质不同），故未列入对比表，避免用二手博客编造实现细节。
