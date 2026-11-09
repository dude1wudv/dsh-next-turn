# dsh-next-turn

DeepSeek Harness 插件：**一轮完全结束后**，用当前会话的模型预测你下一句最可能输入的话，以 ghost text 显示在输入框里；按 `Tab` 填入，`Esc` 或 `×` 忽略。打开「自动」后每轮自动填入并提交，形成自驱续跑循环（有轮次上限等安全阀）。

## 交互

| 操作 | 效果 |
| --- | --- |
| `Tab` | 把建议填入输入框（只在草稿为空、且建议已生成完时生效） |
| `Esc` | 忽略这条建议（输入框聚焦时） |
| `×` | 忽略这条建议，同时中止还在生成中的请求，省 token |
| 工具栏「自动」 | 开关自动模式；开启后显示已自动提交轮次 `自动 3/12` |

建议只在**输入框为空**时出现——它复用宿主「placeholder 可见」这个条件，所以有附件、有草稿、命令认领中都不会打扰。生成中会显示半透明预览，此时 `Tab` 不生效，避免把半句话填进去。

## 触发时机（这一版最重要的修复）

旧版在 `turn/end` 立刻调模型，排队消息、goal 续跑、子代理续跑都会让「上一轮」的建议出现在**正在运行**的下一轮里。现在：

1. `turn/end` 之后先等 `settleMs`（默认 600ms）静默期；
2. 静默期内出现 `turn/start`（说明这一轮没真正结束）→ 取消，不调模型；
3. 生成过程中出现 `turn/start` / `user/message` → 立刻 abort，并清掉旧建议；
4. 只有最后一轮以 assistant 消息收尾时才预测；`error` 轮次直接跳过。

## 输出过滤

模型输出先清洗格式（代码围栏、`建议：` 前缀、引号、列表符号、markdown 强调），再按规则丢弃：

- 空输出 / `NONE` / `无`（模型显式表示「没有下一步」）；
- 评价类：`谢谢`、`好的`、`不错`、`收到`……；
- 助手口吻：`我来`、`让我`、`需要我`……；
- 助手反问：`需要我继续吗？`；
- 代码片段、表格、三句以上的长回复；
- 与用户最近真实说过的话重复（归一化后比较）。

被丢弃时返回空建议，不会把 `[debug]` 之类的内容写进输入框。

## 自动模式安全阀

- `maxAutoTurns`（默认 12）到顶自动关闭，建议保留可手动 `Tab`；
- 模型判断「没有下一步」→ 自动关闭，避免空转；
- 提交被拒（2.5 秒后草稿还在）→ 自动关闭；
- 连续两次预测出同一句 → 自动关闭，避免原地打转。

开关只由你点击或上面这些安全阀改变：**打字、手动发消息都不会把它悄悄关掉**（自动提交只在草稿为空时发生，不会抢你正在写的内容）。

## 配置

```yml
- id: dsh-next-turn
  config:
    enabled: true
    maxAutoTurns: 12
    maxSuggestionChars: 160
    maxInputMessages: 12
    maxMessageChars: 600
    settleMs: 600
    timeoutMs: 10000
    maxOutputTokens: 64
```

## 安装

```powershell
git clone https://github.com/dude1wudv/dsh-next-turn.git
dsh plugin --profile desktop add link:.\dsh-next-turn
```

也可以直接在插件市场/插件管理器里从本地目录安装（选到本仓库根目录即可）。

卸载：`dsh plugin --profile desktop remove dsh-next-turn`。

改完 `lib/client.js` 后需要刷新页面或重启 DSH 才会加载新 bundle（客户端 bundle 有缓存）。

## 实现要点

- **Host**（`lib/index.js`）：只依赖 `ctx.llm.stream` / `ctx.on` / `ctx.inject` 这些公开服务，不 import 宿主内部包；建议缓存在内存里，通过同源路由 `/_dsh/next-turn/*` 给 Client 取。
- **Ghost 对齐**：不猜位置，直接测量原生 `[data-composer-placeholder]` 的 `getBoundingClientRect()`，用同样的 `left/top/width/height` 渲染 ghost，并给卡片加 `data-next-turn-ghost` 由注入的 CSS 隐藏原生 placeholder——两段文字不会叠在一起。位置做了卡片边界钳制，绝对定位的子元素不会撑大页面滚动区。
- **「自动」按钮**：注册在 `conversation.input.left`（正常 flex 子项），不再绝对定位压住右下角发送/停止按钮。
- **共享轮询**：ghost 与「自动」按钮共用一个 per-session store，空闲 1.2s 轮询、生成中 350ms；页面隐藏时不发请求。

## 已知限制 / 路线图

- 预测请求没有复用主对话的 system/tools 前缀，上下文缓存命中率不如同宿主的 `dsh-suggest`（它复用主请求前缀，实测约 93% 命中）。要做得先拿到 agent 的请求装配结果，见 `BENCHMARK.md`。
- 只给一条建议，没有多候选 chips。
- 没有 `settings.general.item` 设置面板，开关走配置文件 + 工具栏按钮。

## 开发

```powershell
node test/smoke.mjs        # Host 行为测试（假 ctx，不连真实模型）
node --check lib/index.js
node --check lib/client.js
```

对标调研见 [BENCHMARK.md](./BENCHMARK.md)，实现过程与踩坑见 [PROGRESS.md](./PROGRESS.md)。
