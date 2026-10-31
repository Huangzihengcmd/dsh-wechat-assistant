/**
 * 微信会话 ↔ DSH Session 的桥。
 *
 * 一个微信用户对一个 DSH Session：首次收到消息时创建，之后按 session id 复用。
 * 投递走 `agent.followup()`——与网页输入框、headless 运行器完全同一条 admission
 * 路径；等待走 `agent.whenIdle()` + 会话日志扫描，正文取该轮最后一条非空
 * `assistant/message`（与 `finalAssistantOutput` 的选择规则一致）。
 *
 * 关键约束（已按宿主 0.2.1-rc.5 的实现核对）：
 * - Web profile 把工具行在 Host 层禁用、按 agent preset 逐会话重组，所以 `setup`
 *   里**必须** `agentPresets.mount()`，否则该 Agent 一个工具都没有。
 * - `ctx.agents.create()` 的会话 id 由调用方自己 mint，没有 id 工厂服务。
 * - 只有 `followup`/`steer` 会真正驱动一轮；`session.append('user/message')` 只写
 *   转录，不会被 inbox 认领。
 *
 * @module dsh-wechat-assistant/bridge
 */
import { randomUUID } from 'node:crypto'

/** 等待一轮结束的超时。 */
const TURN_TIMEOUT_MS = 15 * 60_000
/** whenIdle 轮询的稳定间隔。 */
const IDLE_POLL_MS = 250

/**
 * 深冻结一份结构克隆，语义等同宿主 `createMessage()` 的收尾步骤。
 *
 * @param value - 任意可克隆值。
 * @returns 冻结副本。
 */
function deepFreezeClone(value) {
  const freeze = (node) => {
    if (node === null || typeof node !== 'object') return node
    for (const key of Object.keys(node)) freeze(node[key])
    return Object.freeze(node)
  }
  return freeze(typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)))
}

/**
 * 构造一条与宿主 `createUserMessage()` 等价的消息。
 *
 * @param text - 正文。
 * @returns 冻结的 user 消息。
 */
export function createWeChatUserMessage(text) {
  return deepFreezeClone({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/**
 * 从一条 `assistant/message` 的 content 里取出纯文本。
 *
 * @param content - 消息的内容块数组。
 * @returns 拼好的文本，可能为空串。
 */
export function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('')
}

/**
 * 扫一段会话日志，取最后一条非空 assistant 正文。
 *
 * 空正文的 assistant 消息只在 max-tokens 时出现、只记录用量，所以不能覆盖
 * earlier 输出——这正是宿主 `AssistantOutputFold` 的规则。
 *
 * @param session - 目标 Session。
 * @param fromSeq - 起始 seq（投递前的 `session.seq`）。
 * @returns 正文，可能为空串。
 */
export function readTurnText(session, fromSeq) {
  let text = ''
  const end = session.seq
  for (let seq = fromSeq + 1; seq <= end; seq += 1) {
    const event = session.eventAt?.(seq)
    if (event?.type !== 'assistant/message') continue
    const piece = textOfContent(event.data.message?.content)
    if (piece !== '') text = piece
  }
  return text
}

/**
 * 扫一段会话日志，取最后一个 `turn/end` 的 reason。
 *
 * @param session - 目标 Session。
 * @param fromSeq - 起始 seq。
 * @returns reason，未找到时为 undefined。
 */
export function readTurnReason(session, fromSeq) {
  const end = session.seq
  for (let seq = end; seq > fromSeq; seq -= 1) {
    const event = session.eventAt?.(seq)
    if (event?.type === 'turn/end') return event.data.reason
  }
  return undefined
}

/**
 * 把 DSH 的 Session 与微信用户绑在一起，提供“问一句、答一句”的接口。
 */
export class WeChatAgentBridge {
  #ctx
  #log
  #options
  #queues = new Map()
  #handles = new Map()
  #disposed = false

  /**
   * @param ctx - 插件上下文，需要 `agents` 服务。
   * @param log - 日志函数。
   * @param options - `cwd()` 返回新会话的工作目录。
   */
  constructor(ctx, log, options = {}) {
    this.#ctx = ctx
    this.#log = log
    this.#options = options
  }

  /**
   * 解析默认 preset 与默认模型，供新建/恢复 Agent 复用。
   *
   * @returns `{ presets, presetId, agentOptions }`。
   */
  async #composition() {
    const presets = this.#ctx.get('agentPresets')
    let presetId
    if (presets !== undefined) {
      try {
        presetId = (await presets.resolve(undefined)).id
      } catch (error) {
        this.#log(`解析默认 agent preset 失败：${String(error)}`)
      }
    }
    const selection = this.#ctx.get('agentDefaultModel')?.currentSelection()
    return {
      presets,
      presetId,
      agentOptions:
        selection === undefined ? {} : { provider: selection.provider, model: selection.model },
    }
  }

  /**
   * 取（必要时新建或恢复）某个微信用户对应的 Agent。
   *
   * @param sessionId - 已存在的 Session id，或 undefined 表示新建。
   * @returns `{ agent, sessionId }`。
   */
  async #ensureAgent(sessionId) {
    if (sessionId !== undefined) {
      const live = this.#ctx.agents.get(sessionId)
      if (live !== undefined) return { agent: live, sessionId }
    }
    const { presets, presetId, agentOptions } = await this.#composition()
    // 预设必须在 setup 里挂载：否则这个 Agent 没有工具、没有压缩、没有工具提示词。
    const setup = async (agentCtx) => {
      if (presets !== undefined && presetId !== undefined) await presets.mount(agentCtx, presetId)
    }
    const cwd = this.#options.cwd?.()
    if (sessionId === undefined) {
      let created
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const candidate = `session-${randomUUID()}`
        if (this.#ctx.agents.get(candidate) === undefined) {
          created = candidate
          break
        }
      }
      if (created === undefined) throw new Error('无法生成可用的 Session id')
      const handle = await this.#ctx.agents.create({
        sessionId: created,
        agentOptions,
        meta: {
          ...(cwd === undefined ? {} : { cwd }),
          ...(presetId === undefined ? {} : { agentPreset: presetId }),
        },
        setup,
      })
      this.#handles.set(created, handle)
      this.#log(`已为微信会话创建 DSH Session ${created}`)
      return { agent: handle.agent, sessionId: created }
    }
    const handle = await this.#ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    this.#handles.set(sessionId, handle)
    this.#log(`已恢复微信会话的 DSH Session ${sessionId}`)
    return { agent: handle.agent, sessionId }
  }

  /**
   * 向某个会话投递一句话并等这一轮真正安静下来。
   *
   * @param params - 目标 Session（undefined 时新建）与正文。
   * @returns `{ sessionId, text, reason }`。
   */
  async ask(params) {
    if (this.#disposed) throw new Error('微信助理已停用')
    const { agent, sessionId } = await this.#ensureAgent(params.sessionId)
    const firstSeq = agent.session.seq
    agent.followup(createWeChatUserMessage(params.text))
    await this.#waitForIdle(agent, params.timeoutMs ?? TURN_TIMEOUT_MS)
    const text = readTurnText(agent.session, firstSeq)
    const reason = readTurnReason(agent.session, firstSeq)
    return { sessionId, text, reason }
  }

  /**
   * 等这一轮结束：whenIdle 单独用不够——子代理结算会把它再唤醒一次，
   * 所以要同时确认 seq 稳定、且没有在跑的子代理。
   *
   * @param agent - 目标 Agent。
   * @param timeoutMs - 总超时。
   */
  async #waitForIdle(agent, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    const subagents = this.#ctx.get('subagents')
    while (Date.now() < deadline) {
      await agent.whenIdle()
      const idleSeq = agent.session.seq
      const busy = subagents !== undefined && (await subagents.waitForChildren(agent).catch(() => false))
      if (busy !== true && agent.status === 'idle' && agent.session.seq === idleSeq) return
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, IDLE_POLL_MS)
        timer.unref?.()
      })
    }
    this.#log(`等待微信会话结果超时（${Math.round(timeoutMs / 1000)}s）`)
  }

  /**
   * 串行化同一个微信用户的请求：上一轮没结束就排队，避免插话打断。
   *
   * @param key - 串行键（通常是一个微信用户 id）。
   * @param operation - 要执行的操作。
   * @returns 操作的返回值。
   */
  async serialize(key, operation) {
    const previous = this.#queues.get(key) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    const guard = next.then(
      () => undefined,
      () => undefined,
    )
    this.#queues.set(key, guard)
    guard.then(() => {
      if (this.#queues.get(key) === guard) this.#queues.delete(key)
    })
    return next
  }

  /** 插件卸载：释放自己创建的 Agent。 */
  async dispose() {
    this.#disposed = true
    for (const handle of this.#handles.values()) {
      try {
        await handle.dispose()
      } catch (error) {
        this.#log(`释放 Agent 失败：${String(error)}`)
      }
    }
    this.#handles.clear()
  }
}
