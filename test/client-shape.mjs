/**
 * dsh-next-turn — Client bundle shape test.
 *
 * 不渲染 React，只验证 client bundle 在宿主环境里能安全加载：
 * 1. `window.__ModuleLoader__.load` 被调用且带 id/factory；
 * 2. factory 返回 { inject, apply }，apply 能注册两个槽位
 *    （conversation.input.overlay 与 conversation.input.left）；
 * 3. 注入的 <style> 只挂一次，且规则包含隐藏原生 placeholder 的选择器；
 * 4. 重复 apply 不会重复挂 style。
 *
 * 运行：node test/client-shape.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

const created = []
const appended = []
const documentStub = {
  querySelector(selector) {
    if (selector === 'style[data-dsh-next-turn]') {
      return appended.find((tag) => tag.dataset.dshNextTurn === '1') ?? null
    }
    return null
  },
  createElement(tagName) {
    const tag = { tagName, dataset: {}, textContent: '' }
    created.push(tag)
    return tag
  },
  head: {
    appendChild(tag) {
      appended.push(tag)
    },
  },
  visibilityState: 'visible',
  activeElement: null,
}

let loaded = null
const windowStub = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
  addEventListener() {},
  removeEventListener() {},
}

// 最小 React 替身：组件不会真的渲染，只要 hooks 存在即可。
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
}

const globalSandbox = {
  window: windowStub,
  document: documentStub,
  fetch: async () => ({ ok: false }),
  setTimeout,
  clearTimeout,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
}

// 用 Function 构造一个带沙箱的模块作用域，避免污染真实全局。
const runner = new Function(
  'window',
  'document',
  'fetch',
  'setTimeout',
  'clearTimeout',
  'ResizeObserver',
  'MutationObserver',
  'require',
  source,
)
runner(
  globalSandbox.window,
  globalSandbox.document,
  globalSandbox.fetch,
  globalSandbox.setTimeout,
  globalSandbox.clearTimeout,
  globalSandbox.ResizeObserver,
  globalSandbox.MutationObserver,
  (id) => {
    assert.equal(id, 'react', 'client bundle 只 require react')
    return reactStub
  },
)

assert.ok(loaded !== null, 'window.__ModuleLoader__.load 被调用')
assert.equal(loaded.id, 'dsh-next-turn')
assert.equal(typeof loaded.factory, 'function')

const plugin = loaded.factory((id) => {
  assert.equal(id, 'react')
  return reactStub
})

assert.ok(plugin !== null && typeof plugin === 'object', 'factory 返回插件对象')
assert.deepEqual(plugin.inject, ['slots'])
assert.equal(typeof plugin.apply, 'function')

const registrations = []
const injections = []
const ctx = {
  slots: {
    inject(slotName, callback) {
      injections.push(slotName)
      callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

plugin.apply(ctx)

assert.deepEqual(injections, ['conversation.input.overlay', 'conversation.input.left'], '两个槽位都注入')
assert.equal(registrations.length, 2)
assert.equal(registrations[0].options.name, 'conversation.input.overlay')
assert.equal(registrations[0].options.id, 'next-turn-ghost')
assert.equal(registrations[1].options.name, 'conversation.input.left')
assert.equal(registrations[1].options.id, 'next-turn-auto')
assert.equal(typeof registrations[0].component, 'function')
assert.equal(typeof registrations[1].component, 'function')

assert.equal(appended.length, 1, '样式只挂一次')
assert.match(appended[0].textContent, /data-next-turn-ghost/u, '样式包含 ghost 标记选择器')
assert.match(appended[0].textContent, /\[data-composer-placeholder\]/u, '样式隐藏原生 placeholder')
assert.match(appended[0].textContent, /visibility:hidden/u)

// 再次 apply 不应重复挂 style
plugin.apply(ctx)
assert.equal(appended.length, 1, '重复 apply 不重复挂样式')
assert.equal(registrations.length, 4, '重复 apply 会重复注册槽位（由宿主去重）')

console.log('dsh-next-turn client shape: ok')
