/**
 * dsh-next-turn — Host smoke test.
 *
 * 用假 ctx 驱动 apply()，覆盖这一版最容易回归的行为：
 * 1. 路由缓存（request/header 与 request/context 两条来源）；
 * 2. 「整轮完全结束」闸门：turn/end 后要过静默期才调模型，期间 turn/start 取消；
 * 3. 生成中遇到新一轮/用户消息/忽略建议时立刻 abort，且不把错误写成建议；
 * 4. 输出过滤层：助手口吻、评价类、NONE、反问、带格式、与用户重复的话都丢弃；
 * 5. 自动模式安全阀：轮次上限、用户介入、模型判断没有下一步都会关闭；
 * 6. /status、/auto、/consumed、/dismiss 路由与参数校验。
 *
 * 运行：node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeHarness(config = {}) {
  const handlers = new Map()
  const routes = new Map()
  const calls = []
  /** 每次 llm.stream 依次取一个脚本；{ text, delayMs } */
  const scripted = []

  const ctx = {
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    on(event, handler) {
      handlers.set(event, handler)
    },
    inject(_services, callback) {
      callback({
        effect(cb) {
          cb()
        },
        connection: {
          requestRejection() {
            return undefined
          },
        },
        webServer: {
          register(route) {
            routes.set(route.path, route)
            return () => routes.delete(route.path)
          },
        },
      })
    },
    effect(callback) {
      callback()
    },
    llm: {
      async *stream(options) {
        calls.push(options)
        const script = scripted.shift() ?? { text: '继续。' }
        for (const chunk of splitChunks(script.text)) {
          if (options.signal?.aborted) throw abortError()
          if (script.delayMs) await sleep(script.delayMs)
          if (options.signal?.aborted) throw abortError()
          yield { type: 'text-delta', text: chunk }
        }
        if (options.signal?.aborted) throw abortError()
        yield { type: 'finish' }
      },
    },
  }

  const messages = [
    { role: 'user', content: [{ type: 'text', text: '帮我把这个插件写完' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好，我先写 Host。' }] },
  ]
  const session = {
    id: 'session-1',
    deriveMessages() {
      return messages
    },
    snapshotEvents() {
      return []
    },
  }

  function fire(event) {
    const handler = handlers.get('session/event')
    assert.ok(handler, 'session/event handler registered')
    return handler(session, event)
  }

  function fireDisposed() {
    const handler = handlers.get('session/disposed')
    assert.ok(handler, 'session/disposed handler registered')
    return handler(session)
  }

  async function callRoute(path, method = 'GET', body) {
    const route = routes.get('/_dsh/next-turn')
    assert.ok(route, 'route registered')
    const req = {
      method,
      url: `http://localhost${path}`,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      },
    }
    let status = 0
    let payload = ''
    const res = {
      writeHead(code) {
        status = code
      },
      end(chunk) {
        payload = chunk ?? ''
      },
    }
    await route.handler(req, res)
    return { status, body: payload ? JSON.parse(payload) : null }
  }

  const status = (sessionId = 'session-1') => callRoute(`/_dsh/next-turn/status?session=${sessionId}`)

  return { ctx, session, messages, scripted, calls, fire, fireDisposed, callRoute, status }
}

function splitChunks(text) {
  if (text === '') return []
  return text.match(/[\s\S]{1,4}/gu)
}

function abortError() {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/** 一轮结束并等过静默期，让生成跑完。 */
async function endTurnAndSettle(harness, waitMs = 40) {
  await harness.fire({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await sleep(waitMs)
}

// —— 1. 路由缓存 + 基础生成 ——
{
  const harness = makeHarness()
  apply(harness.ctx, { settleMs: 5, maxSuggestionChars: 50 })

  await harness.fire({
    type: 'request/header',
    data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } },
  })
  harness.scripted.push({ text: '继续写 Client。' })
  await endTurnAndSettle(harness)

  assert.equal(harness.calls.length, 1, 'llm.stream called once')
  assert.equal(harness.calls[0].provider, 'deepseek-official')
  assert.equal(harness.calls[0].model, 'deepseek-v4-flash')
  assert.equal(harness.calls[0].maxTokens, 64, '默认 64 token 封顶')
  assert.equal(harness.calls[0].purpose, 'next-turn')
  assert.match(harness.calls[0].system, /NONE/u, '系统提示词包含空值契约')

  const status = await harness.status()
  assert.equal(status.status, 200)
  assert.equal(status.body.ok, true)
  assert.equal(status.body.suggestion, '继续写 Client。')
  assert.equal(status.body.pending, false)
  assert.equal(status.body.running, false)
  assert.equal(status.body.auto, false)
  assert.equal(status.body.maxAutoTurns, 12)

  // request/context 也能刷新路由
  await harness.fire({ type: 'request/context', data: { provider: 'p2', model: 'm2' } })
  harness.scripted.push({ text: '再跑一遍测试。' })
  await endTurnAndSettle(harness)
  assert.equal(harness.calls[1].provider, 'p2')
  assert.equal(harness.calls[1].model, 'm2')
}

// —— 2. 静默期闸门：turn/end 后紧接着 turn/start 就不生成 ——
{
  const harness = makeHarness()
  apply(harness.ctx, { settleMs: 20 })
  await harness.fire({ type: 'request/context', data: { provider: 'p', model: 'm' } })

  await harness.fire({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await sleep(2)
  await harness.fire({ type: 'turn/start', data: { turn: 2 } })
  await sleep(60)

  assert.equal(harness.calls.length, 0, '新一轮开始后不再生成上一轮的建议')
  const status = await harness.status()
  assert.equal(status.body.running, true, '运行中状态可见')
  assert.equal(status.body.suggestion, '')
}

// —— 3. 生成中遇到新一轮：abort 且不留下错误文本 ——
{
  const harness = makeHarness()
  apply(harness.ctx, { settleMs: 5 })
  await harness.fire({ type: 'request/context', data: { provider: 'p', model: 'm' } })

  harness.scripted.push({ text: '这一句会很长很长很长很长很长', delayMs: 15 })
  await harness.fire({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await sleep(15) // 静默期已过，生成已经开始
  assert.equal(harness.calls.length, 1, '生成已启动')
  await harness.fire({ type: 'turn/start', data: { turn: 2 } })
  await sleep(60)

  const status = await harness.status()
  assert.equal(status.body.suggestion, '', '取消后不保留半句建议')
  assert.equal(status.body.error, '', '取消不算错误')
  assert.equal(harness.calls.length, 1, '不会重试')
}

// —— 4. 输出过滤层 ——
{
  const cases = [
    ['我来帮你改一下', '', '助手口吻'],
    ['让我先看看代码', '', '助手口吻'],
    ['谢谢', '', '评价类'],
    ['好的', '', '评价类'],
    ['NONE', '', '空值契约'],
    ['无', '', '空值契约'],
    ['需要我继续吗？', '', '助手反问'],
    ['```js\nconsole.log(1)\n```', '', '代码片段'],
    ['```\n跑一下测试\n```', '跑一下测试', '围栏里是正常建议时去掉围栏'],
    ['帮我把这个插件写完', '', '与用户刚说过的话重复'],
    ['跑一下测试', '跑一下测试', '正常建议保留'],
    ['建议：跑一下测试', '跑一下测试', '去掉「建议：」前缀'],
  ]

  for (const [raw, expected, label] of cases) {
    const harness = makeHarness()
    apply(harness.ctx, { settleMs: 5 })
    await harness.fire({ type: 'request/context', data: { provider: 'p', model: 'm' } })
    harness.scripted.push({ text: raw })
    await endTurnAndSettle(harness)
    const status = await harness.status()
    assert.equal(status.body.suggestion, expected, `${label}: ${JSON.stringify(raw)}`)
  }
}

// —— 5. 用户消息清空建议，但不关闭自动模式 ——
{
  const harness = makeHarness()
  apply(harness.ctx, { settleMs: 5 })
  await harness.fire({ type: 'request/context', data: { provider: 'p', model: 'm' } })

  harness.scripted.push({ text: '跑一下测试' })
  await endTurnAndSettle(harness)
  assert.equal((await harness.status()).body.suggestion, '跑一下测试')

  await harness.fire({ type: 'user/message', data: {} })
  assert.equal((await harness.status()).body.suggestion, '', '用户发消息后旧建议失效')

  // 自动模式：用户手动发消息不关闭开关（只由用户点击或安全阀改变）
  await harness.callRoute('/_dsh/next-turn/auto?session=session-1', 'POST', { enabled: true, reset: true })
  assert.equal((await harness.status()).body.auto, true)
  await harness.fire({ type: 'user/message', data: {} })
  assert.equal((await harness.status()).body.auto, true, '用户手动发消息后自动模式保持开启')
}

// —— 6. 自动提交记录 lastConsumed，但不影响开关 ——
{
  const harness = makeHarness()
  apply(harness.ctx, { settleMs: 5 })
  await harness.fire({ type: 'request/context', data: { provider: 'p', model: 'm' } })
  await harness.callRoute('/_dsh/next-turn/auto?session=session-1', 'POST', { enabled: true, reset: true })
  const consumed = await harness.callRoute('/_dsh/next-turn/consumed?session=session-1', 'POST', { text: '跑一下测试' })
  assert.equal(consumed.body.ok, true)
  await harness.fire({ type: 'user/message', data: {} })
  const status = await harness.status()
  assert.equal(status.body.auto, true, '自动提交后的 user/message 不影响开关')
  assert.equal(status.body.lastConsumed, '跑一下测试')
}

// —— 7. 安全阀：轮次上限 ——
{
  const harness = makeHarness()
  apply(harness.ctx, { settleMs: 5, maxAutoTurns: 2 })
  await harness.fire({ type: 'request/context', data: { provider: 'p', model: 'm' } })
  await harness.callRoute('/_dsh/next-turn/auto?session=session-1', 'POST', { enabled: true, reset: true })

  harness.scripted.push({ text: '第一步' })
  await endTurnAndSettle(harness)
  harness.scripted.push({ text: '第二步' })
  await endTurnAndSettle(harness)

  const status = await harness.status()
  assert.equal(status.body.auto, false, '达到上限自动关闭')
  assert.equal(status.body.turns, 2)
  assert.equal(status.body.suggestion, '第二步', '自动关掉后建议仍然保留，可以手动 Tab 采纳')
}

// —— 8. 安全阀：模型判断没有下一步 → 自动关闭 ——
{
  const harness = makeHarness()
  apply(harness.ctx, { settleMs: 5 })
  await harness.fire({ type: 'request/context', data: { provider: 'p', model: 'm' } })
  await harness.callRoute('/_dsh/next-turn/auto?session=session-1', 'POST', { enabled: true, reset: true })
  harness.scripted.push({ text: 'NONE' })
  await endTurnAndSettle(harness)
  const status = await harness.status()
  assert.equal(status.body.suggestion, '')
  assert.equal(status.body.auto, false, '空建议时关闭自动模式')
}

// —— 9. dismiss：清建议并中止在途生成 ——
{
  const harness = makeHarness()
  apply(harness.ctx, { settleMs: 5 })
  await harness.fire({ type: 'request/context', data: { provider: 'p', model: 'm' } })
  harness.scripted.push({ text: '这一句会很长很长很长很长很长', delayMs: 15 })
  await harness.fire({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await sleep(15)
  assert.equal(harness.calls.length, 1)
  const dismissed = await harness.callRoute('/_dsh/next-turn/dismiss?session=session-1', 'POST', {})
  assert.equal(dismissed.body.ok, true)
  await sleep(60)
  const status = await harness.status()
  assert.equal(status.body.suggestion, '', '忽略后不保留建议')
  assert.equal(status.body.error, '')
}

// —— 10. 出错的一轮不预测 ——
{
  const harness = makeHarness()
  apply(harness.ctx, { settleMs: 5 })
  await harness.fire({ type: 'request/context', data: { provider: 'p', model: 'm' } })
  await harness.fire({ type: 'turn/end', data: { reason: { kind: 'error' } } })
  await sleep(40)
  assert.equal(harness.calls.length, 0, 'error 轮次不生成')
}

// —— 11. 路由参数校验 + session/disposed 清理 ——
{
  const harness = makeHarness()
  apply(harness.ctx, { settleMs: 5 })
  await harness.fire({ type: 'request/context', data: { provider: 'p', model: 'm' } })
  harness.scripted.push({ text: '跑一下测试' })
  await endTurnAndSettle(harness)
  await harness.callRoute('/_dsh/next-turn/auto?session=session-1', 'POST', { enabled: true, reset: true })

  const bad = await harness.callRoute('/_dsh/next-turn/status', 'GET')
  assert.equal(bad.status, 400, '缺 session 参数返回 400')

  const badBody = await harness.callRoute('/_dsh/next-turn/auto?session=session-1', 'POST', undefined)
  assert.equal(badBody.status, 200, '空 body 按 {} 处理')

  harness.fireDisposed()
  const status = await harness.status()
  assert.equal(status.body.suggestion, '', 'disposed 后清空建议')
  assert.equal(status.body.auto, false, 'disposed 后清空自动状态')
}

console.log('dsh-next-turn smoke: ok')
