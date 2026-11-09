/**
 * dsh-next-turn — browser half.
 *
 * 两个槽位：
 * - `conversation.input.overlay`：ghost text。位置**测量原生 placeholder**
 *   得到（`[data-composer-placeholder]`），逐像素对齐；显示时给卡片加
 *   `data-next-turn-ghost`，由注入的 CSS 把原生 placeholder 隐藏，避免两段
 *   文字叠在一起。placeholder 只在「草稿为空 + 无附件 + 无命令认领」时存在，
 *   所以它同时充当「可以显示 ghost」的判据，不再需要轮询草稿内容。
 * - `conversation.input.left`：工具栏里的「自动」开关（list 槽位，正常 flex
 *   子项），不再绝对定位压住右下角的发送/停止按钮。
 *
 * 交互：Tab 填入、Esc 忽略、× 忽略；生成中显示半透明预览且不接受 Tab。
 * 自动模式：新建议到达且输入框空闲时填入并提交。开关只由用户点击或安全阀
 * （轮次上限、模型判断没有下一步、提交被拒、连续两次同一句）改变；用户打字
 * 或手动发消息不会把它悄悄关掉。
 *
 * @module dsh-next-turn/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-next-turn',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const STATUS_PATH = '/_dsh/next-turn/status'
    const AUTO_PATH = '/_dsh/next-turn/auto'
    const CONSUMED_PATH = '/_dsh/next-turn/consumed'
    const DISMISS_PATH = '/_dsh/next-turn/dismiss'

    const POLL_IDLE_MS = 1200
    const POLL_PENDING_MS = 350
    const AUTO_SUBMIT_DELAY_MS = 120
    const AUTO_VERIFY_MS = 2500

    const EMPTY_STATE = {
      suggestion: '',
      ts: 0,
      pending: false,
      running: false,
      auto: false,
      turns: 0,
      maxAutoTurns: 12,
      error: '',
      lastConsumed: '',
    }

    const GHOST_CSS = [
      '[data-composer-card][data-next-turn-ghost="1"] [data-composer-placeholder]{visibility:hidden !important}',
    ].join('\n')

    /** 注入一次插件样式；宿主允许插件往 document.head 挂 style。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-dsh-next-turn]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.dshNextTurn = '1'
      tag.dataset.plugin = 'dsh-next-turn'
      tag.textContent = GHOST_CSS
      document.head.appendChild(tag)
    }

    // —— 每个会话一个共享 store：ghost 与「自动」按钮共用一次轮询 ——
    const stores = new Map()

    function createStore(sessionId) {
      const store = {
        sessionId,
        state: EMPTY_STATE,
        listeners: new Set(),
        timer: null,
        alive: false,
        set(patch) {
          store.state = { ...store.state, ...patch }
          for (const listener of store.listeners) listener()
        },
        subscribe(listener) {
          store.listeners.add(listener)
          store.ensure()
          return () => {
            store.listeners.delete(listener)
            if (store.listeners.size === 0) store.stop()
          }
        },
        ensure() {
          if (store.alive) return
          store.alive = true
          void store.poll()
        },
        stop() {
          store.alive = false
          if (store.timer !== null) {
            clearTimeout(store.timer)
            store.timer = null
          }
        },
        /** 立刻拉一次状态：开关按钮点完立即调用，不必等下一轮轮询。 */
        refresh() {
          if (!store.alive) return
          if (store.timer !== null) {
            clearTimeout(store.timer)
            store.timer = null
          }
          void store.poll()
        },
        async poll() {
          if (!store.alive) return
          let delay = POLL_IDLE_MS
          try {
            const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
            if (!hidden) {
              const response = await fetch(`${STATUS_PATH}?session=${encodeURIComponent(sessionId)}`, {
                cache: 'no-store',
                credentials: 'same-origin',
                headers: { accept: 'application/json' },
              })
              if (response.ok) {
                const payload = await response.json()
                if (payload?.ok) {
                  store.set({
                    suggestion: typeof payload.suggestion === 'string' ? payload.suggestion : '',
                    ts: Number(payload.ts) || 0,
                    pending: payload.pending === true,
                    running: payload.running === true,
                    auto: payload.auto === true,
                    turns: Number(payload.turns) || 0,
                    maxAutoTurns: Number(payload.maxAutoTurns) || 12,
                    error: typeof payload.error === 'string' ? payload.error : '',
                    lastConsumed: typeof payload.lastConsumed === 'string' ? payload.lastConsumed : '',
                  })
                  delay = payload.pending === true ? POLL_PENDING_MS : POLL_IDLE_MS
                }
              }
            }
          } catch {
            // 路由还没挂上或网络抖动：下一轮再试。
          }
          if (!store.alive) return
          store.timer = setTimeout(() => void store.poll(), delay)
        },
        async post(path, body) {
          try {
            await fetch(`${path}?session=${encodeURIComponent(sessionId)}`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body ?? {}),
            })
          } catch {
            // 失败就下一次轮询自然纠正。
          }
        },
      }
      return store
    }

    function storeFor(sessionId) {
      let store = stores.get(sessionId)
      if (store === undefined) {
        store = createStore(sessionId)
        stores.set(sessionId, store)
      }
      return store
    }

    /** 订阅某个会话的建议/自动模式状态。 */
    function useNextTurn(sessionId) {
      const store = typeof sessionId === 'string' && sessionId !== '' ? storeFor(sessionId) : null
      const [state, setState] = useState(() => (store === null ? EMPTY_STATE : store.state))
      useEffect(() => {
        if (store === null) return undefined
        setState(store.state)
        return store.subscribe(() => setState(store.state))
      }, [store])
      return [state, store]
    }

    function cardOf(root) {
      return root?.closest?.('[data-composer-card]') ?? null
    }

    function editorOf(card) {
      return card?.querySelector?.('[contenteditable="true"]') ?? null
    }

    /** 草稿为空 ⇔ 宿主渲染了 placeholder（空草稿 + 无附件 + 无命令认领）。 */
    function draftIsEmpty(card) {
      return card?.querySelector?.('[data-composer-placeholder]') != null
    }

    function draftText(card) {
      const editor = editorOf(card)
      return (editor?.textContent ?? '').trim()
    }

    function isFocusedIn(card) {
      const active = typeof document === 'undefined' ? null : document.activeElement
      if (active === null) return false
      const editor = editorOf(card)
      return active === editor || (editor !== null && editor.contains(active))
    }

    // —— ghost text：位于输入框覆盖层，位置对齐原生 placeholder ——
    function GhostOverlay(props) {
      const sessionId = props?.sessionId
      const inputActions = props?.inputActions
      const useInput = props?.useInput
      const inputPhase = useInput ? useInput((s) => s?.phase) : 'plain'
      const [state, store] = useNextTurn(sessionId)
      const rootRef = useRef(null)
      const [rect, setRect] = useState(null)
      const dismissedTs = useRef(0)
      const lastAutoTs = useRef(0)
      const pendingAutoTs = useRef(0)
      const verifyTimers = useRef([])
      const mountedRef = useRef(true)
      const phaseRef = useRef(inputPhase)
      phaseRef.current = inputPhase

      const suggestion = state.suggestion
      const frozen = inputPhase === 'adjudicating' || inputPhase === 'submitting' || inputPhase === 'sending'
      const visible =
        typeof sessionId === 'string' &&
        sessionId !== '' &&
        suggestion !== '' &&
        rect !== null &&
        state.ts !== dismissedTs.current &&
        state.running !== true &&
        frozen !== true

      // 保持最新值给事件回调，避免每次变化都重绑监听。
      const visibleRef = useRef(visible)
      visibleRef.current = visible
      const stateRef = useRef(state)
      stateRef.current = state

      // 测量 placeholder：ResizeObserver + MutationObserver + 滚动/重渲染兜底。
      // 关键：输入框会从「首屏居中」切到「底部停靠」，卡片位置变了但尺寸可能不变，
      // ResizeObserver 不会触发；只测一次会把 ghost 画到卡片外，撑大滚动区。
      const measureRef = useRef(null)
      useEffect(() => {
        const root = rootRef.current
        const card = cardOf(root)
        if (card === null) return undefined
        const scroll = card.querySelector('[data-input-scroll]') ?? card
        const measure = () => {
          const placeholder = card.querySelector('[data-composer-placeholder]')
          if (placeholder === null) {
            setRect((previous) => (previous === null ? previous : null))
            return
          }
          // overlayAnchor 定位在卡片 padding box 左上角，所以用卡片 rect 作原点。
          const cardRect = card.getBoundingClientRect()
          const placeholderRect = placeholder.getBoundingClientRect()
          // 钳制在卡片可视范围内：绝对定位的子元素会撑大祖先的滚动区，
          // 万一测量拿到异常值（布局切换、动画、缩放），也不让页面多出空白滚动。
          const maxTop = Math.max(0, card.clientHeight - placeholderRect.height)
          const maxLeft = Math.max(0, card.clientWidth - 1)
          const next = {
            left: Math.min(Math.max(placeholderRect.left - cardRect.left, 0), maxLeft),
            top: Math.min(Math.max(placeholderRect.top - cardRect.top, 0), maxTop),
            width: Math.max(0, Math.min(placeholderRect.width, card.clientWidth)),
            height: Math.max(0, Math.min(placeholderRect.height, card.clientHeight)),
          }
          setRect((previous) => {
            if (
              previous !== null &&
              Math.abs(previous.left - next.left) < 0.5 &&
              Math.abs(previous.top - next.top) < 0.5 &&
              Math.abs(previous.width - next.width) < 0.5 &&
              Math.abs(previous.height - next.height) < 0.5
            ) {
              return previous
            }
            return next
          })
        }
        measureRef.current = measure
        measure()
        const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        resizeObserver?.observe(card)
        resizeObserver?.observe(scroll)
        const mutationObserver = typeof MutationObserver === 'function' ? new MutationObserver(measure) : null
        mutationObserver?.observe(scroll, { childList: true, subtree: true, characterData: true })
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        return () => {
          measureRef.current = null
          resizeObserver?.disconnect()
          mutationObserver?.disconnect()
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
        }
      }, [sessionId])

      // 每次渲染后重测一次：轮询本身每 1.2s 触发一次渲染，位置变化最迟一轮内纠正。
      useEffect(() => {
        measureRef.current?.()
      })

      // 显示 ghost 时隐藏原生 placeholder；组件卸载/隐藏时恢复。
      useEffect(() => {
        const card = cardOf(rootRef.current)
        if (card === null) return undefined
        if (visible) card.setAttribute('data-next-turn-ghost', '1')
        else card.removeAttribute('data-next-turn-ghost')
        return () => card.removeAttribute('data-next-turn-ghost')
      }, [visible])

      const dismiss = useCallback(() => {
        dismissedTs.current = stateRef.current.ts
        void store?.post(DISMISS_PATH, {})
      }, [store])

      // Tab 填入 / Esc 忽略：绑在自己的卡片上，多个 composer 互不干扰。
      useEffect(() => {
        const card = cardOf(rootRef.current)
        if (card === null) return undefined
        const onKeyDown = (event) => {
          if (!visibleRef.current) return
          if (event.key === 'Escape') {
            if (!isFocusedIn(card)) return
            event.preventDefault()
            event.stopPropagation()
            dismiss()
            return
          }
          if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return
          // 生成中的预览不接受 Tab，避免把半句填进去。
          if (stateRef.current.pending) return
          if (!isFocusedIn(card)) return
          if (!draftIsEmpty(card)) return
          if (typeof inputActions?.setDraft !== 'function') return
          event.preventDefault()
          event.stopPropagation()
          dismissedTs.current = stateRef.current.ts
          inputActions.setDraft(stateRef.current.suggestion)
        }
        card.addEventListener('keydown', onKeyDown, true)
        return () => card.removeEventListener('keydown', onKeyDown, true)
      }, [dismiss, inputActions])

      // 自动模式：新建议到达且输入框空闲 → 填入并提交。
      useEffect(() => {
        if (state.auto !== true || state.pending === true || state.running === true) return undefined
        if (suggestion === '' || state.ts === 0) return undefined
        if (state.ts === lastAutoTs.current || state.ts === dismissedTs.current) return undefined
        if (state.turns >= state.maxAutoTurns) return undefined
        if (inputPhase !== 'plain') return undefined
        const card = cardOf(rootRef.current)
        if (card === null || !draftIsEmpty(card)) return undefined
        if (typeof inputActions?.setDraft !== 'function' || typeof inputActions?.submit !== 'function') return undefined
        // 与上一轮自动提交的内容相同：说明模型在原地打转，停掉自动模式。
        if (state.lastConsumed !== '' && suggestion === state.lastConsumed) {
          void store?.post(AUTO_PATH, { enabled: false })
          return undefined
        }
        // 同一条建议只安排一次提交；定时器不随重渲染取消，避免轮询把提交吞掉。
        if (state.ts === pendingAutoTs.current) return undefined

        const ts = state.ts
        const text = suggestion
        pendingAutoTs.current = ts
        inputActions.setDraft(text)
        const submitTimer = setTimeout(() => {
          if (!mountedRef.current) return
          lastAutoTs.current = ts
          try {
            inputActions.submit()
          } catch {
            void store?.post(AUTO_PATH, { enabled: false })
            return
          }
          void store?.post(CONSUMED_PATH, { text })
          const verifyTimer = setTimeout(() => {
            // 2.5s 后仍停在 plain 且草稿还是我们填的那句 → 提交被拒，关掉自动。
            const currentCard = cardOf(rootRef.current)
            if (phaseRef.current === 'plain' && currentCard !== null && draftText(currentCard) === text) {
              void store?.post(AUTO_PATH, { enabled: false })
            }
          }, AUTO_VERIFY_MS)
          verifyTimers.current.push(verifyTimer)
        }, AUTO_SUBMIT_DELAY_MS)
        verifyTimers.current.push(submitTimer)
        return undefined
      }, [state.auto, state.pending, state.running, state.ts, state.turns, state.maxAutoTurns, state.lastConsumed, suggestion, inputPhase, store, inputActions])

      // 用户自己开始打字不再关闭自动模式：自动提交本来就只在草稿为空时发生，
      // 用户有草稿时不会抢输入框；开关状态只由用户点击或安全阀改变。
      // 组件卸载时清掉未执行的定时器，并标记已卸载，避免提交打到死组件上。
      useEffect(() => {
        mountedRef.current = true
        const timers = verifyTimers.current
        return () => {
          mountedRef.current = false
          for (const timer of timers) clearTimeout(timer)
          timers.length = 0
        }
      }, [])

      if (!visible) {
        return h('div', {
          ref: rootRef,
          'data-next-turn': 'root',
          style: { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 3 },
        })
      }

      return h(
        'div',
        {
          ref: rootRef,
          'data-next-turn': 'root',
          style: { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 3 },
        },
        h(
          'div',
          {
            'data-next-turn': 'ghost',
            style: {
              position: 'absolute',
              left: `${rect.left}px`,
              top: `${rect.top}px`,
              width: `${rect.width}px`,
              height: `${rect.height}px`,
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              minWidth: 0,
              pointerEvents: 'none',
              color: 'var(--dsw-alias-label-caption)',
              opacity: state.pending ? 0.55 : 1,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              font: 'inherit',
              lineHeight: 'inherit',
              userSelect: 'none',
            },
          },
          h(
            'span',
            {
              style: {
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            suggestion,
          ),
          state.pending
            ? null
            : h(
                'span',
                {
                  'data-next-turn': 'hint',
                  style: {
                    flex: 'none',
                    fontSize: '11px',
                    lineHeight: '16px',
                    padding: '0 5px',
                    borderRadius: '4px',
                    border: '1px solid var(--dsw-alias-border-l2)',
                    color: 'var(--dsw-alias-label-tertiary)',
                  },
                },
                'Tab',
              ),
          h(
            'button',
            {
              type: 'button',
              'aria-label': '忽略这条建议',
              title: '忽略这条建议（Esc）',
              onClick: dismiss,
              style: {
                flex: 'none',
                pointerEvents: 'auto',
                border: 'none',
                background: 'transparent',
                color: 'var(--dsw-alias-label-tertiary)',
                cursor: 'pointer',
                fontSize: '14px',
                lineHeight: 1,
                padding: '2px 4px',
                borderRadius: '4px',
              },
            },
            '×',
          ),
        ),
      )
    }

    // —— 「自动」开关：放进输入框左侧工具栏，正常 flex 子项，不压发送键 ——
    function AutoToggle(props) {
      const sessionId = props?.sessionId
      const [state, store] = useNextTurn(sessionId)
      // 乐观状态：点击立即变色/变文字，不等下一轮轮询，避免「点了没反应」被反复点。
      const [pendingAuto, setPendingAuto] = useState(null)
      /** 用户最近一次点击想要的状态；null 表示跟随宿主。连点时靠它取反。 */
      const pendingRef = useRef(null)
      /** 防抖定时器：连点只发最后一次请求。 */
      const postTimer = useRef(null)
      const auto = pendingAuto === null ? state.auto === true : pendingAuto

      // 宿主状态追上乐观值后清掉；2 秒兜底，避免请求失败时按钮卡在乐观值。
      useEffect(() => {
        if (pendingAuto === null) return undefined
        if (state.auto === pendingAuto) {
          pendingRef.current = null
          setPendingAuto(null)
          return undefined
        }
        const timer = setTimeout(() => {
          pendingRef.current = null
          setPendingAuto(null)
        }, 2000)
        return () => clearTimeout(timer)
      }, [pendingAuto, state.auto])

      // 卸载时清掉还没发出的防抖请求。
      useEffect(
        () => () => {
          if (postTimer.current !== null) clearTimeout(postTimer.current)
        },
        [],
      )

      const toggle = useCallback(() => {
        if (store === null) return
        // 用 ref 读「当前想要的状态」：同一帧里连点两次也能正确取反。
        const current = pendingRef.current === null ? state.auto === true : pendingRef.current
        const next = !current
        pendingRef.current = next
        setPendingAuto(next)
        // 连点只发最后一次：请求乱序会把状态打回旧值，看起来就像「点了没用」。
        if (postTimer.current !== null) clearTimeout(postTimer.current)
        postTimer.current = setTimeout(() => {
          postTimer.current = null
          void store.post(AUTO_PATH, { enabled: next, reset: next }).then(() => store.refresh())
        }, 140)
      }, [store, state.auto])

      const label = auto ? `自动 ${state.turns}/${state.maxAutoTurns}` : '自动'
      const title = auto
        ? `自动模式已开启：每轮结束后自动发送预测的下一句（${state.turns}/${state.maxAutoTurns}）。点击关闭`
        : `开启自动模式：每轮结束后自动发送预测的下一句，最多 ${state.maxAutoTurns} 轮。打字或手动发消息不会关闭它`

      return h(
        'button',
        {
          type: 'button',
          onClick: toggle,
          title,
          'aria-pressed': auto,
          'data-next-turn': 'auto',
          'data-state': auto ? 'on' : 'off',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            flex: 'none',
            height: '28px',
            // 固定宽度：开着时多出「3/12」，不固定会让按钮在工具栏里左右跳。
            minWidth: '92px',
            padding: '0 10px',
            borderRadius: '999px',
            border: 'none',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: 500,
            lineHeight: '20px',
            whiteSpace: 'nowrap',
            background: auto ? 'var(--dsw-alias-button-info-fill)' : 'var(--dsw-specific-selector)',
            color: auto ? '#fff' : 'var(--dsw-alias-label-secondary)',
            boxShadow: auto ? 'inset 0 0 0 1px rgba(255,255,255,.22)' : 'none',
            transition: 'background-color 160ms ease, color 160ms ease, box-shadow 160ms ease',
          },
        },
        h('span', {
          'aria-hidden': true,
          style: {
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            flex: 'none',
            background: auto ? '#fff' : 'var(--dsw-alias-label-tertiary)',
            opacity: auto ? 1 : 0.7,
            transform: auto ? 'scale(1.2)' : 'scale(1)',
            transition: 'transform 160ms ease, background-color 160ms ease, opacity 160ms ease',
          },
        }),
        label,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyle()
        // 槽位在旧版宿主上可能不存在：注册失败时退化为只提供 ghost，
        // 不要让一个槽位把整个插件带崩。
        const register = (slotName, id, component) => {
          try {
            ctx.slots.inject(slotName, () => ctx.slots.register({ name: slotName, id, order: 10 }, component))
          } catch (error) {
            if (typeof console !== 'undefined') console.warn(`[dsh-next-turn] 无法注册槽位 ${slotName}`, error)
          }
        }
        register('conversation.input.overlay', 'next-turn-ghost', GhostOverlay)
        register('conversation.input.left', 'next-turn-auto', AutoToggle)
      },
    }
  },
})
