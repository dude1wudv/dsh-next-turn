/**
 * dsh-next-turn — Host half.
 *
 * 一轮**完全结束**后，用当前会话的模型路由调用一次宿主默认模型，预测用户
 * 「下一句最可能说的话」。建议缓存在内存里，由 Client 通过同源路由取走：
 *   GET  /_dsh/next-turn/status?session=<id>
 *   POST /_dsh/next-turn/auto       { enabled, reset }
 *   POST /_dsh/next-turn/consumed   { text }   自动模式真正提交后计数
 *   POST /_dsh/next-turn/dismiss               用户忽略这条建议
 *
 * 触发时机（这是本插件最容易做错的地方）：
 * - 只监听 `turn/end`，但**不立即**调模型：先等 `settleMs` 静默期；
 * - 静默期内出现 `turn/start`（排队消息、goal 续跑、子代理续跑）就取消，
 *   因为那一轮还没「完全结束」；
 * - 生成过程中出现 `turn/start` 或 `user/message`，立刻 abort 并清掉旧建议，
 *   避免把上一轮的预测显示在正在运行的轮次里；
 * - 只有最后一轮确实以 assistant 消息收尾时才预测。
 *
 * 设计原则：不硬依赖 @deepseek-ai/dsh-llm 等内部包，只用 ctx 上的公开服务
 * （ctx.llm.stream / ctx.on / ctx.inject），这样插件在 profile 里能独立加载。
 *
 * @module dsh-next-turn
 */

export const name = 'dsh-next-turn'
export const inject = ['llm', 'sessions']

const ROUTE_PATH = '/_dsh/next-turn'

const SYSTEM_PROMPT = [
  '你是「下一轮提示词预测器」，运行在 DeepSeek Harness 里。',
  '读下面的对话，预测用户接下来最可能输入的一句话，输出一条可以直接发送的提示词。',
  '规则：',
  '- 站在用户视角写给助手，而不是替助手回答。',
  '- 只输出提示词本身：不要解释、不要引号、不要 markdown、不要「用户：」之类前缀。',
  '- 用对话的语言；中文对话就输出中文。',
  '- 像用户自己会打的字：简短、具体、可执行，一般不超过 40 个字。',
  '- 顺着对话的下一步走（继续实现、验证、修 bug、解释、收尾），不要复述助手刚说过的话。',
  '- 如果对话已经自然收尾、没有合理的下一步，只输出 NONE。',
].join('\n')

/** 模型显式表达「本轮没有建议」的标记。 */
const NONE_MARKERS = new Set(['none', 'null', 'nil', 'n/a', '无', '没有', '（无）', '(无)', ''])

/** 纯评价类回复：用户下一句不可能是这个，直接丢弃。 */
const EVALUATIVE_RE = /^(?:谢谢|多谢|感谢|不错|很好|好|好的|好滴|可以|行|嗯+|哦+|收到|明白(?:了)?|了解了?|ok|okay)[。！!.,，~～\s]*$/iu

/** 助手口吻：模型把自己当成助手在回答，丢弃。 */
const ASSISTANT_VOICE_RE = /^(?:我(?:来|会|可以|先|这就|马上)|让我|需要我|要不要我|是否要我|希望(?:能|这)|以下(?:是|为)|好的[，,]\s*我)/u

/** 助手反问式结尾：模型在问用户要不要继续，丢弃。 */
const ASSISTANT_QUESTION_RE = /(?:需要我|要不要我|是否要|要我|可以吗|好吗|行吗|怎么样)[？?]?\s*$/u

/** 代码片段（裸函数调用、声明开头）：不是一句能直接发送的提示词。 */
const CODE_LIKE_RE = /^(?:[\w$.]+\s*\([^)]*\)\s*;?|(?:import|export|const|let|var|function|class|def|return|public|private)\s)/u

/** 成对包裹的引号 / 标签。 */
const WRAPPER_RE = /^(?:["'“”‘’「」『』]+)|(?:["'“”‘’「」『』]+)$/gu

/** 从消息内容的 block 数组里取纯文本。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** 取最近若干条 user/assistant 文本消息，按时间正序。 */
function recentMessages(session, limit, perMessageLimit) {
  let messages = []
  try {
    messages = session.deriveMessages()
  } catch {
    return []
  }
  const out = []
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const message = messages[i]
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue
    const text = textOf(message.content).trim()
    if (!text) continue
    out.unshift({ role: message.role, text: text.length > perMessageLimit ? `${text.slice(0, perMessageLimit)}…` : text })
  }
  return out
}

/** 把最近消息拼成给预测器的输入。 */
function buildInput(messages) {
  return messages
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.text}`)
    .join('\n\n')
}

/** 从 stream 分片里累积文本，兼容 text-delta 的几种字段名。 */
function deltaOf(chunk) {
  if (!chunk || typeof chunk !== 'object') return ''
  if (chunk.type === 'text-delta' || chunk.type === 'text') {
    if (typeof chunk.text === 'string') return chunk.text
    if (typeof chunk.delta === 'string') return chunk.delta
  }
  return ''
}

/**
 * 把模型输出整理成一条可发送的提示词；返回 '' 表示本轮没有可用建议。
 *
 * 过滤规则参考 dsh-suggest 与 Open WebUI：先清洗格式，再按「空 / 评价类 /
 * 助手口吻 / 反问 / 多句 / 带格式 / 与用户刚说过的话重复」逐条丢弃。
 *
 * @param raw 模型原始输出
 * @param maxChars 长度上限
 * @param recentUserTexts 最近几条用户真实发送的消息，用于去重
 */
function sanitizeSuggestion(raw, maxChars, recentUserTexts = []) {
  let text = String(raw ?? '').trim()
  if (!text) return ''
  // 代码围栏、前缀、列表符号、包裹引号
  text = text.replace(/^```[a-zA-Z]*\s*/u, '').replace(/\s*```$/u, '')
  text = text.replace(/^(?:建议|下一句|下一轮|next(?: prompt)?)\s*[：:]\s*/iu, '')
  text = text.replace(/^(?:用户|user)\s*[：:]\s*/iu, '')
  text = text.replace(/^(?:[-*•]|\d+[.)])\s+/u, '')
  text = text.replace(WRAPPER_RE, '')
  // 压成单行
  text = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).join(' ')
  text = text.replace(/\s{2,}/gu, ' ').trim()
  // 去掉 markdown 强调与行内代码反引号
  text = text.replace(/[*_~`]+/gu, '').trim()
  if (!text) return ''

  const normalized = text.toLowerCase()
  if (NONE_MARKERS.has(normalized)) return ''
  // 带未闭合代码块/表格/标题的内容不是一句可发送的提示词
  if (/```|\|.*\|/u.test(text)) return ''
  if (CODE_LIKE_RE.test(text)) return ''
  if (EVALUATIVE_RE.test(text)) return ''
  if (ASSISTANT_VOICE_RE.test(text)) return ''
  if (ASSISTANT_QUESTION_RE.test(text)) return ''
  // 三句以上太啰嗦，ghost 只有一行
  if ((text.match(/[。！？.!?]/gu) ?? []).length >= 3) return ''
  // 与用户最近真实说过的话重复（归一化后比较，避免建议刚做过的事）
  const squash = (value) => value.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
  const squashed = squash(text)
  if (!squashed) return ''
  for (const previous of recentUserTexts) {
    const candidate = squash(String(previous ?? ''))
    if (!candidate) continue
    if (candidate === squashed) return ''
    if (squashed.length >= 6 && candidate.startsWith(squashed)) return ''
  }

  if (text.length > maxChars) text = text.slice(0, maxChars).trim()
  return text
}

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  if (!enabled) return

  const positiveInt = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback)
  const maxAutoTurns = positiveInt(config.maxAutoTurns, 12)
  const maxSuggestionChars = positiveInt(config.maxSuggestionChars, 160)
  const maxInputMessages = positiveInt(config.maxInputMessages, 12)
  const maxMessageChars = positiveInt(config.maxMessageChars, 600)
  const settleMs = Number.isInteger(config.settleMs) && config.settleMs >= 0 ? config.settleMs : 600
  const timeoutMs = positiveInt(config.timeoutMs, 10000)
  const maxOutputTokens = positiveInt(config.maxOutputTokens, 64)

  /** sessionId -> { text, ts, pending, error } */
  const suggestions = new Map()
  /** sessionId -> { auto, turns, lastConsumed } */
  const autoState = new Map()
  /** sessionId -> { provider, model } 最近一次请求路由 */
  const routes = new Map()
  /** sessionId -> boolean 会话是否正在跑一轮 */
  const running = new Map()
  /** sessionId -> 静默期定时器 */
  const timers = new Map()
  /** sessionId -> 代次；turn/start 会 +1 使旧的静默期回调失效 */
  const generations = new Map()
  /** sessionId -> AbortController 正在生成中的建议请求 */
  const controllers = new Map()
  /** 正在生成中的 sessionId，避免重复请求 */
  const generating = new Set()

  const routeOf = (sessionId) => routes.get(sessionId) ?? null

  /** 从会话日志里兜底找最近一次请求路由（插件加载前的历史也能覆盖）。 */
  function routeFromSession(session) {
    try {
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]
        if (!event) continue
        if (event.type === 'request/header') {
          const headerConfig = event.data?.header?.config
          if (typeof headerConfig?.provider === 'string' && typeof headerConfig?.model === 'string') {
            return { provider: headerConfig.provider, model: headerConfig.model }
          }
        }
        if (event.type === 'request/context') {
          const data = event.data ?? {}
          if (typeof data.provider === 'string' && typeof data.model === 'string') {
            return { provider: data.provider, model: data.model }
          }
        }
      }
    } catch {
      // 日志读取失败就退回事件缓存。
    }
    return null
  }

  function autoOf(sessionId) {
    const state = autoState.get(sessionId)
    if (!state) return { auto: false, turns: 0, lastConsumed: '' }
    return {
      auto: state.auto === true,
      turns: state.turns,
      lastConsumed: state.lastConsumed ?? '',
    }
  }

  /** 关掉自动模式（保留轮次计数），并记一条日志。 */
  function disableAuto(sessionId, reason) {
    const state = autoState.get(sessionId)
    if (!state?.auto) return
    state.auto = false
    ctx.logger?.info?.(`dsh-next-turn: 会话 ${sessionId} 自动模式关闭（${reason}）`)
  }

  function clearTimer(sessionId) {
    const timer = timers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(sessionId)
    }
  }

  function bumpGeneration(sessionId) {
    const next = (generations.get(sessionId) ?? 0) + 1
    generations.set(sessionId, next)
    return next
  }

  /** 取消正在进行的生成，并丢弃这一轮的建议。 */
  function cancelGeneration(sessionId, { clearSuggestion = true } = {}) {
    clearTimer(sessionId)
    const controller = controllers.get(sessionId)
    if (controller !== undefined) {
      controllers.delete(sessionId)
      try {
        controller.abort()
      } catch {
        // 已经结束的请求 abort 会抛，忽略。
      }
    }
    if (clearSuggestion) suggestions.delete(sessionId)
  }

  /** 一轮结束后排一个静默期，确认没有后续轮次再生成。 */
  function scheduleGeneration(session) {
    const sessionId = session.id
    clearTimer(sessionId)
    const token = bumpGeneration(sessionId)
    const timer = setTimeout(() => {
      timers.delete(sessionId)
      if (generations.get(sessionId) !== token) return
      if (running.get(sessionId) === true) return
      void generate(session)
    }, settleMs)
    timers.set(sessionId, timer)
  }

  async function generate(session) {
    const sessionId = session.id
    if (generating.has(sessionId)) return
    const route = routeOf(sessionId) ?? routeFromSession(session)
    if (!route) {
      ctx.logger?.warn?.('dsh-next-turn: 没有可用的模型路由，跳过本次预测')
      return
    }
    const messages = recentMessages(session, maxInputMessages, maxMessageChars)
    if (messages.length === 0) return
    // 最后一轮没有 assistant 收尾（例如只有一条用户消息）时不预测。
    if (messages[messages.length - 1].role !== 'assistant') return
    const recentUserTexts = messages
      .filter((message) => message.role === 'user')
      .slice(-3)
      .map((message) => message.text)

    const startedAt = Date.now()
    generating.add(sessionId)
    const controller = new AbortController()
    controllers.set(sessionId, controller)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let text = ''
    let lastPublish = 0
    try {
      for await (const chunk of ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: buildInput(messages) }] }],
        system: SYSTEM_PROMPT,
        sessionId,
        maxTokens: maxOutputTokens,
        purpose: 'next-turn',
        signal: controller.signal,
      })) {
        text += deltaOf(chunk)
        const now = Date.now()
        if (now - lastPublish >= 150 && !controller.signal.aborted) {
          lastPublish = now
          const partial = sanitizeSuggestion(text, maxSuggestionChars, recentUserTexts)
          if (partial) suggestions.set(sessionId, { text: partial, ts: startedAt, pending: true, error: '' })
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`dsh-next-turn: 生成建议失败: ${message}`)
        suggestions.set(sessionId, { text: '', ts: startedAt, pending: false, error: message.slice(0, 200) })
      } else {
        // 被取消时可能已经写进过半句预览，清掉，别让它在输入框里复活。
        suggestions.delete(sessionId)
      }
      return
    } finally {
      clearTimeout(timer)
      generating.delete(sessionId)
      if (controllers.get(sessionId) === controller) controllers.delete(sessionId)
    }

    // 流正常结束但期间已被取消（例如最后一刻来了新一轮）：同样不落建议。
    if (controller.signal.aborted) return

    const suggestion = sanitizeSuggestion(text, maxSuggestionChars, recentUserTexts)
    suggestions.set(sessionId, { text: suggestion, ts: startedAt, pending: false, error: '' })
    // 模型明确表示「没有下一步」时，自动模式继续跑只会空转，直接关掉。
    if (suggestion === '') disableAuto(sessionId, '模型判断没有下一步')
  }

  ctx.on('session/event', (session, event) => {
    if (!event || typeof event !== 'object') return
    const sessionId = session.id

    // 记住这个会话最近一次模型路由，生成建议时复用同一 provider/model。
    if (event.type === 'request/header') {
      const headerConfig = event.data?.header?.config
      if (typeof headerConfig?.provider === 'string' && typeof headerConfig?.model === 'string') {
        routes.set(sessionId, { provider: headerConfig.provider, model: headerConfig.model })
      }
      return
    }
    if (event.type === 'request/context') {
      const data = event.data ?? {}
      if (typeof data.provider === 'string' && typeof data.model === 'string') {
        routes.set(sessionId, { provider: data.provider, model: data.model })
      }
      return
    }

    // 新一轮开始：上一轮并没有「完全结束」，取消静默期与在途请求，丢弃旧建议。
    if (event.type === 'turn/start') {
      running.set(sessionId, true)
      bumpGeneration(sessionId)
      cancelGeneration(sessionId)
      return
    }

    // 用户发了消息（手动或自动）：旧建议已经过期。
    // 注意：这里**不**关自动模式。自动模式是用户显式开关的状态，打字/发消息
    // 只是用户参与对话，不该把开关悄悄关掉；真正的安全阀见 turn/end 与生成结果。
    if (event.type === 'user/message') {
      suggestions.delete(sessionId)
      return
    }

    if (event.type !== 'turn/end') return

    running.set(sessionId, false)
    // 安全阀：自动模式下每结束一轮计数一次，达到上限自动关闭。
    // 建议本身照常生成：自动关掉之后用户仍然可以 Tab 手动采纳。
    const state = autoState.get(sessionId)
    if (state?.auto) {
      state.turns += 1
      if (state.turns >= maxAutoTurns) {
        state.auto = false
        ctx.logger?.info?.(`dsh-next-turn: 会话 ${sessionId} 自动模式达到 ${maxAutoTurns} 轮上限，已关闭`)
      }
    }

    const kind = event.data?.reason?.kind
    if (kind === 'error') {
      // 出错的一轮不预测，避免把错误现场当成对话上下文。
      suggestions.delete(sessionId)
      return
    }
    scheduleGeneration(session)
  })

  ctx.on('session/disposed', (session) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    cancelGeneration(sessionId)
    suggestions.delete(sessionId)
    autoState.delete(sessionId)
    routes.delete(sessionId)
    running.delete(sessionId)
    generations.delete(sessionId)
    generating.delete(sessionId)
  })

  // —— 同源路由：Client 轮询建议与自动模式状态 ——
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    webCtx.effect(() => {
      const respond = (res, status, payload) => {
        const body = JSON.stringify(payload)
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
        })
        res.end(body)
      }

      const readBody = async (req) => {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        try {
          return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        } catch {
          return null
        }
      }

      const dispose = webCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PATH,
        handler: async (req, res) => {
          try {
            const rejection = webCtx.connection.requestRejection(req)
            if (rejection !== undefined) {
              respond(res, rejection, { ok: false, error: rejection === 401 ? 'authentication required' : 'request rejected' })
              return
            }

            const url = new URL(req.url || '/', 'http://localhost')
            const sessionId = url.searchParams.get('session') || ''
            if (!sessionId) {
              respond(res, 400, { ok: false, error: 'session is required' })
              return
            }

            if (url.pathname === `${ROUTE_PATH}/status` && req.method === 'GET') {
              const suggestion = suggestions.get(sessionId)
              const state = autoOf(sessionId)
              respond(res, 200, {
                ok: true,
                suggestion: suggestion?.text ?? '',
                ts: suggestion?.ts ?? 0,
                pending: suggestion?.pending === true,
                error: suggestion?.error ?? '',
                running: running.get(sessionId) === true,
                auto: state.auto,
                turns: state.turns,
                maxAutoTurns,
                lastConsumed: state.lastConsumed,
              })
              return
            }

            if (url.pathname === `${ROUTE_PATH}/auto` && req.method === 'POST') {
              const body = await readBody(req)
              if (body === null) {
                respond(res, 400, { ok: false, error: 'invalid JSON body' })
                return
              }
              const previous = autoOf(sessionId)
              autoState.set(sessionId, {
                auto: body.enabled === true,
                turns: body.reset === true ? 0 : previous.turns,
                lastConsumed: previous.lastConsumed,
              })
              if (body.enabled !== true) cancelGeneration(sessionId, { clearSuggestion: false })
              respond(res, 200, { ok: true, auto: body.enabled === true })
              return
            }

            if (url.pathname === `${ROUTE_PATH}/consumed` && req.method === 'POST') {
              const body = await readBody(req)
              if (body === null) {
                respond(res, 400, { ok: false, error: 'invalid JSON body' })
                return
              }
              const state = autoState.get(sessionId) ?? { auto: false, turns: 0, lastConsumed: '' }
              state.lastConsumed = typeof body.text === 'string' ? body.text : ''
              autoState.set(sessionId, state)
              respond(res, 200, { ok: true })
              return
            }

            if (url.pathname === `${ROUTE_PATH}/dismiss` && req.method === 'POST') {
              // 用户不要这条建议：清掉它，并中止还在跑的生成，省掉后续 token。
              cancelGeneration(sessionId)
              respond(res, 200, { ok: true })
              return
            }

            respond(res, 404, { ok: false, error: 'not found' })
          } catch (error) {
            respond(res, 500, { ok: false, error: error instanceof Error ? error.message : 'internal error' })
          }
        },
      })
      return () => dispose()
    }, 'dsh-next-turn.routes')
  })
}
