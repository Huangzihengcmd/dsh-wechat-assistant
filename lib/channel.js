/**
 * 通道运行时：扫码登录、长轮询收消息、把回复发回微信。
 *
 * 生命周期由设置页的“连接 / 取消连接”驱动：`start()` 建一条长轮询循环，
 * `stop()` 立刻中止在途请求。所有网络状态都在这里，HTTP 路由只做转发。
 *
 * @module dsh-wechat-assistant/channel
 */
import { randomUUID } from 'node:crypto'
import {
  FIXED_BASE_URL,
  STALE_TOKEN_ERRCODE,
  fetchLoginQrCode,
  getBotConfig,
  getUpdates,
  messageBody,
  notifyLifecycle,
  pollLoginQrStatus,
  sendTextMessage,
  sendTyping,
} from './weixin.js'
import { loadAccount, loadContextTokens, loadSyncBuf, saveAccount, saveContextToken, saveSyncBuf } from './store.js'
import { claimOwnerIfUnset, loadAllowlist, requestAccess, verdictOf } from './allowlist.js'
import { agentNamed, checkModel, listCatalog, loadAgents, upsertAgent } from './agents.js'
import { buildLocalTokenList, loadCoexist } from './coexist.js'

/** 连续失败这么多次就退避。 */
const MAX_CONSECUTIVE_FAILURES = 3
/** 退避时长。 */
const BACKOFF_DELAY_MS = 30_000
/** 普通重试间隔。 */
const RETRY_DELAY_MS = 2_000
/** 会话失效后的冷却时长（服务端要求）。 */
const SESSION_PAUSE_MS = 60 * 60_000
/** 扫码登录的轮询上限。 */
const LOGIN_TIMEOUT_MS = 8 * 60_000
/** 二维码过期后最多刷新几次。 */
const MAX_QR_REFRESH = 3
/** 单条微信消息允许的最大字符数，超过就截断，避免超长回复被服务端拒绝。 */
const MAX_REPLY_CHARS = 4_000

/**
 * 把 Markdown 压平成微信聊天窗口能显示的样子：去掉代码围栏与强调符号，
 * 链接只留文字，标题只留正文。
 *
 * @param text - 模型输出的原始文本。
 * @returns 适合直接发送的纯文本。
 */
export function toWeChatPlainText(text) {
  let out = String(text ?? '')
  out = out.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) => body.trimEnd())
  out = out.replace(/`([^`\n]+)`/g, '$1')
  out = out.replace(/!\[[^\]]*\]\(([^)]*)\)/g, '$1')
  out = out.replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1')
  out = out.replace(/^#{1,6}\s+/gm, '')
  out = out.replace(/(\*\*|__)(.+?)\1/g, '$2')
  out = out.replace(/(\*|_)(.+?)\1/g, '$2')
  out = out.replace(/^>\s?/gm, '')
  out = out.replace(/\n{3,}/g, '\n\n')
  out = out.trim()
  if (out.length > MAX_REPLY_CHARS) out = `${out.slice(0, MAX_REPLY_CHARS)}\n…（内容过长已截断）`
  return out
}

/** 一次扫码登录的进行中状态。 */
class LoginAttempt {
  constructor() {
    this.qrcodeUrl = ''
    this.qrcode = ''
    this.status = 'wait'
    this.error = ''
    this.verifyCode = ''
    this.done = false
    this.accountId = ''
    this.cancelled = false
  }
}

/**
 * 一个微信账号的通道：登录态、长轮询循环与收发。
 */
export class WeChatChannel {
  #ctx
  #log
  #bridge
  #account = undefined
  #controller = undefined
  #login = undefined
  #pausedUntil = 0
  /** 微信用户 → DSH Session id，键为「用户::Agent 名」。 */
  #sessions = new Map()
  /** 微信用户 → 当前使用的 Agent 名。 */
  #currentAgents = new Map()
  /** Agent 注册表缓存。 */
  #registryCache = undefined
  /** 微信用户 → `{ ticket, fetchedAt }`，避免每条消息都打一次 getconfig。 */
  #typingTickets = new Map()
  /** 账号变更（登录成功）时的监听者。 */
  #accountListeners = new Set()
  /** 发送者授权状态：主人、已批准、待审批。 */
  #allowlist = { owner: '', allowed: [], pending: [] }
  #options
  #stats = { inbound: 0, outbound: 0, lastInboundAt: 0, lastError: '' }

  /**
   * @param ctx - 插件上下文。
   * @param log - 日志函数。
   * @param bridge - 负责把消息交给 DSH 的桥。
   * @param options - `cwd()` 返回新会话的工作目录。
   */
  constructor(ctx, log, bridge, options = {}) {
    this.#ctx = ctx
    this.#log = log
    this.#bridge = bridge
    this.#options = options
  }

  /** 当前发送者授权状态（给设置页与路由用）。 */
  get allowlist() {
    return this.#allowlist
  }

  /**
   * 从磁盘载入授权状态。插件启动时调用一次。
   */
  async loadAccess() {
    this.#allowlist = await loadAllowlist()
    return this.#allowlist
  }

  /**
   * 覆盖内存中的授权状态（设置页批准/撤销后调用）。
   *
   * @param next - 新的授权状态。
   */
  setAccess(next) {
    this.#allowlist = next
  }

  /**
   * 订阅“登录成功后拿到了哪个账号”。
   *
   * @param listener - 收到 ilink bot id。
   * @returns 退订函数。
   */
  onAccountChanged(listener) {
    this.#accountListeners.add(listener)
    return () => this.#accountListeners.delete(listener)
  }

  /** 当前账号凭据（未登录为 undefined）。 */
  get account() {
    return this.#account
  }

  /** 通道是否在跑。 */
  get running() {
    return this.#controller !== undefined && this.#controller.signal.aborted === false
  }

  /** 给设置页看的状态快照。 */
  snapshot() {
    return {
      running: this.running,
      accountId: this.#account?.accountId,
      userId: this.#account?.userId,
      baseUrl: this.#account?.baseUrl,
      login: this.#login === undefined ? undefined : {
        status: this.#login.status,
        qrcodeUrl: this.#login.qrcodeUrl,
        error: this.#login.error,
        done: this.#login.done,
        accountId: this.#login.accountId,
      },
      stats: { ...this.#stats },
      pausedUntil: this.#pausedUntil > Date.now() ? this.#pausedUntil : 0,
    }
  }

  /**
   * 从磁盘恢复上次登录的账号，但不自动开跑。
   *
   * 恢复出的账号带有它当初的 user id；那正是当初扫码并授权的人，所以在还没有
   * 主人时把它认领为主人——否则升级到带门控的版本后，这个账号自己反而会被拒。
   *
   * @param accountId - ilink bot id。
   * @returns 是否找到可用凭据。
   */
  async restore(accountId) {
    const stored = await loadAccount(accountId)
    if (stored?.token === undefined) return false
    this.#account = {
      accountId,
      token: stored.token,
      baseUrl: stored.baseUrl ?? FIXED_BASE_URL,
      userId: stored.userId,
    }
    if (typeof stored.userId === 'string' && stored.userId !== '') {
      if (this.#allowlist.owner === '' && this.#allowlist.allowed.length === 0) {
        await this.loadAccess()
      }
      const before = this.#allowlist.owner
      this.#allowlist = await claimOwnerIfUnset(stored.userId)
      if (before === '' && this.#allowlist.owner === stored.userId) {
        this.#log(`已把已登录账号的主人认领为 ${stored.userId}`)
      }
    }
    return true
  }

  /**
   * 发起一次扫码登录，返回二维码链接给设置页渲染。
   *
   * 重复调用时不会重置仍在等待扫码的会话——用户点了「刷新」但当前码还有效时，
   * 继续用这张码（微信那边扫码结果与码一一对应，重置反而会让用户刚扫的码失效）。
   * 只有当上一次登录已经结束（成功、失败、取消或超时）才会换一张新码。
   *
   * @returns `{ qrcodeUrl }`。
   */
  async beginLogin() {
    if (this.#login !== undefined && this.#login.done === false && this.#login.qrcodeUrl !== '') {
      return { qrcodeUrl: this.#login.qrcodeUrl }
    }
    const attempt = new LoginAttempt()
    this.#login = attempt
    // 把本机已知的所有 clawbot 账号一并报上去：服务端据此知道这台机器已经
    // 绑过哪些 bot，扫码时便不会新建一个并让旧的失效（否则 WorkBuddy 之类的
    // 同机应用会被顶掉）。
    const coexist = await loadCoexist()
    const localTokenList = buildLocalTokenList(this.#account?.token, coexist)
    const response = await fetchLoginQrCode({ localTokenList })
    attempt.qrcode = response.qrcode
    attempt.qrcodeUrl = response.qrcode_img_content
    this.#log(
      `已获取微信登录二维码${localTokenList.length > 1 ? `（已上报 ${localTokenList.length} 个本机 bot 账号以避免顶掉其他应用）` : ''}`,
    )
    void this.#pollLogin(attempt, FIXED_BASE_URL)
    return { qrcodeUrl: attempt.qrcodeUrl }
  }

  /**
   * 强制换一张新码：作废当前等待中的扫码，重新向微信要一张。
   *
   * 二维码过期、用户点错了页面、或者只是想重试时用这个。「刷新」按钮调的
   * 就是它；普通的 `beginLogin()` 在旧码还有效时不会换码。
   *
   * @returns `{ qrcodeUrl }`。
   */
  async refreshLogin() {
    if (this.#login !== undefined) {
      this.#login.cancelled = true
      this.#login.done = true
      this.#login = undefined
    }
    return this.beginLogin()
  }

  /**
   * 提交手机微信上显示的数字（只有部分账号会遇到）。
   *
   * @param code - 数字配对码。
   */
  submitVerifyCode(code) {
    if (this.#login === undefined) throw new Error('当前没有进行中的登录')
    this.#login.verifyCode = String(code ?? '').trim()
  }

  /** 放弃当前扫码。 */
  cancelLogin() {
    if (this.#login !== undefined) {
      this.#login.cancelled = true
      this.#login.done = true
      this.#login.status = 'cancelled'
      this.#login = undefined
    }
  }

  /**
   * 扫码登录的长轮询循环，直到拿到凭据、过期或用户取消。
   *
   * @param attempt - 本次登录状态。
   * @param initialBaseUrl - 起始地址，可能被 IDC 重定向替换。
   */
  async #pollLogin(attempt, initialBaseUrl) {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    let baseUrl = initialBaseUrl
    let scanned = false
    let refreshCount = 1
    while (Date.now() < deadline && attempt.cancelled === false) {
      const response = await pollLoginQrStatus({
        baseUrl,
        qrcode: attempt.qrcode,
        verifyCode: attempt.verifyCode,
      })
      if (attempt.cancelled) return
      attempt.status = response.status ?? 'wait'
      // 等待扫码、等待用户输入数字配对码：都只是继续轮询。
      if (attempt.status === 'wait' || attempt.status === 'need_verifycode') {
        await sleep(1000)
        continue
      }
      if (attempt.status === 'scaned') {
        if (!scanned) this.#log('微信已扫码，正在确认授权')
        scanned = true
        attempt.verifyCode = ''
        await sleep(1000)
        continue
      }
      // IDC 重定向：后续轮询换到新域名。
      if (attempt.status === 'scaned_but_redirect' && typeof response.redirect_host === 'string') {
        baseUrl = `https://${response.redirect_host}`
        await sleep(1000)
        continue
      }
      if (attempt.status === 'expired' || attempt.status === 'verify_code_blocked') {
        // 二维码过期是常态（微信的码有时效），自动换一张继续等，不把用户
        // 踢回重来。刷新次数只是防御性上限：真正的兜底是页面上的「刷新二维码」。
        refreshCount += 1
        if (refreshCount > MAX_QR_REFRESH) {
          attempt.status = 'expired'
          attempt.error = '二维码已过期，请点击「刷新二维码」获取新的。'
          this.#log('二维码已过期，等待用户刷新')
          this.#finishLogin(attempt, false, attempt.error)
          return
        }
        try {
          const refreshed = await fetchLoginQrCode({})
          attempt.qrcode = refreshed.qrcode
          attempt.qrcodeUrl = refreshed.qrcode_img_content
          attempt.error = ''
          attempt.status = 'wait'
          scanned = false
          this.#log('二维码已过期，已自动换发一张')
        } catch (error) {
          this.#finishLogin(attempt, false, `刷新二维码失败：${String(error?.message ?? error)}`)
          return
        }
        continue
      }
      if (attempt.status === 'binded_redirect') {
        this.#finishLogin(attempt, false, '该微信已连接过，无需重复连接')
        return
      }
      if (attempt.status === 'confirmed') {
        if (typeof response.ilink_bot_id !== 'string' || response.ilink_bot_id === '') {
          this.#finishLogin(attempt, false, '登录失败：服务器未返回 ilink_bot_id')
          return
        }
        const accountId = response.ilink_bot_id
        const token = response.bot_token
        const resolvedBaseUrl = typeof response.baseurl === 'string' && response.baseurl !== '' ? response.baseurl : FIXED_BASE_URL
        await saveAccount(accountId, {
          token,
          baseUrl: resolvedBaseUrl,
          userId: response.ilink_user_id,
        })
        this.#account = { accountId, token, baseUrl: resolvedBaseUrl, userId: response.ilink_user_id }
        // 第一个扫码的人就是这台机器的主人：只有他能驱动 Agent，其他人需要
        // 显式批准。已经设过主人的账号不会被后来扫码的人顶替。
        this.#allowlist = await claimOwnerIfUnset(response.ilink_user_id)
        if (this.#allowlist.owner === response.ilink_user_id) {
          this.#log(`已把扫码者设为默认主人：${response.ilink_user_id}`)
        }
        for (const listener of this.#accountListeners) {
          try {
            listener(accountId)
          } catch (error) {
            this.#log(`账号持久化回调失败：${String(error)}`)
          }
        }
        this.#finishLogin(attempt, true, '')
        attempt.accountId = accountId
        await this.start()
        return
      }
      await sleep(1000)
    }
    if (attempt.cancelled === false) this.#finishLogin(attempt, false, '登录超时，请重试')
  }

  #finishLogin(attempt, ok, error) {
    attempt.done = true
    attempt.error = error
    if (ok) {
      attempt.status = 'confirmed'
      this.#log(`微信登录成功：${attempt.accountId}`)
    } else {
      attempt.status = 'failed'
      if (error !== '') this.#log(`微信登录未完成：${error}`)
    }
  }

  /** 启动长轮询。没有凭据时直接返回。 */
  async start() {
    if (this.#account === undefined) return false
    if (this.running) return true
    const controller = new AbortController()
    this.#controller = controller
    void notifyLifecycle({
      baseUrl: this.#account.baseUrl,
      token: this.#account.token,
      stopping: false,
    }).catch(() => undefined)
    void this.#monitor(controller.signal)
    this.#log(`微信助理已连接：${this.#account.accountId}`)
    return true
  }

  /** 停止长轮询并通知服务端。 */
  async stop() {
    const controller = this.#controller
    this.#controller = undefined
    controller?.abort()
    if (this.#account !== undefined) {
      void notifyLifecycle({
        baseUrl: this.#account.baseUrl,
        token: this.#account.token,
        stopping: true,
      }).catch(() => undefined)
    }
    this.#log('微信助理已断开连接')
  }

  /** 彻底登出：停止并清空内存中的凭据。 */
  async signOut() {
    await this.stop()
    this.#account = undefined
  }

  /**
   * 长轮询主循环：收消息 → 转成一轮对话 → 把结果发回去。
   *
   * @param signal - 取消信号。
   */
  async #monitor(signal) {
    const account = this.#account
    if (account === undefined) return
    let buf = await loadSyncBuf(account.accountId)
    let failures = 0
    let nextTimeoutMs
    while (!signal.aborted) {
      if (this.#pausedUntil > Date.now()) {
        await sleep(this.#pausedUntil - Date.now(), signal)
        continue
      }
      try {
        const response = await getUpdates({
          baseUrl: account.baseUrl,
          token: account.token,
          getUpdatesBuf: buf,
          timeoutMs: nextTimeoutMs,
          signal,
        })
        if (signal.aborted) return
        if (typeof response.longpolling_timeout_ms === 'number' && response.longpolling_timeout_ms > 0) {
          nextTimeoutMs = response.longpolling_timeout_ms
        }
        const failed = (response.ret !== undefined && response.ret !== 0) || (response.errcode !== undefined && response.errcode !== 0)
        if (failed) {
          const stale = response.errcode === STALE_TOKEN_ERRCODE || response.ret === STALE_TOKEN_ERRCODE
          if (stale) {
            this.#pausedUntil = Date.now() + SESSION_PAUSE_MS
            this.#stats.lastError = '微信会话已过期，需要重新扫码连接'
            this.#log('微信会话已过期，暂停一小时后重试；重新连接可立即恢复')
            continue
          }
          failures += 1
          this.#stats.lastError = `getUpdates ret=${response.ret ?? response.errcode} ${response.errmsg ?? ''}`.trim()
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            failures = 0
            await sleep(BACKOFF_DELAY_MS, signal)
          } else {
            await sleep(RETRY_DELAY_MS, signal)
          }
          continue
        }
        failures = 0
        if (typeof response.get_updates_buf === 'string' && response.get_updates_buf !== '') {
          buf = response.get_updates_buf
          await saveSyncBuf(account.accountId, buf)
        }
        for (const message of response.msgs ?? []) {
          if (signal.aborted) return
          void this.#handleInbound(account, message).catch((error) => {
            this.#stats.lastError = String(error?.message ?? error)
            this.#log(`处理微信消息失败：${String(error?.message ?? error)}`)
          })
        }
      } catch (error) {
        if (signal.aborted) return
        failures += 1
        this.#stats.lastError = String(error?.message ?? error)
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          failures = 0
          await sleep(BACKOFF_DELAY_MS, signal)
        } else {
          await sleep(RETRY_DELAY_MS, signal)
        }
      }
    }
  }

  /**
   * 处理一条入站消息：同一用户串行，带“正在输入”，把回答发回去。
   *
   * 身份门控在这里：只有主人和已批准的发送者能驱动 Agent。陌生人发的消息
   * 不会进入任何 DSH Session——只会被记进待审批列表，并收到一条说明。
   *
   * @param account - 当前账号。
   * @param message - 微信消息。
   */
  async #handleInbound(account, message) {
    if (message.message_type !== undefined && message.message_type !== 1) return
    const userId = message.from_user_id
    if (typeof userId !== 'string' || userId === '') return
    const text = messageBody(message).trim()
    if (text === '') return
    const contextToken = message.context_token
    if (typeof contextToken === 'string' && contextToken !== '') {
      await saveContextToken(account.accountId, userId, contextToken)
    }

    // 身份门控：未获授权的发送者到此为止，绝不创建 Session、绝不调用 Agent。
    const verdict = verdictOf(this.#allowlist, userId)
    if (verdict === 'pending') {
      this.#stats.inbound += 1
      this.#stats.lastInboundAt = Date.now()
      await requestAccess(userId)
      this.#allowlist = await requestAccess(userId)
      const tokens = await loadContextTokens(account.accountId)
      const token = typeof contextToken === 'string' && contextToken !== '' ? contextToken : tokens[userId]
      this.#stats.outbound += 1
      await sendTextMessage({
        baseUrl: account.baseUrl,
        token: account.token,
        to: userId,
        text:
          '这个微信还没有获得授权，因此你的指令没有被执行。请在运行 DSH 的电脑上打开「设置 → 微信助理 → 访问控制」批准你的账号。',
        clientId: `dsh-wechat-${randomUUID()}`,
        contextToken: token,
      }).catch((error) => {
        this.#log(`回复未授权用户失败：${String(error?.message ?? error)}`)
      })
      return
    }

    this.#stats.inbound += 1
    this.#stats.lastInboundAt = Date.now()
    await this.#bridge.serialize(`${account.accountId}:${userId}`, async () => {
      const accountNow = this.#account
      if (accountNow === undefined) return
      const tokens = await loadContextTokens(accountNow.accountId)
      const token = typeof contextToken === 'string' && contextToken !== '' ? contextToken : tokens[userId]

      /** 回一条纯文本，不经过 Agent。 */
      const replyPlain = async (body) => {
        this.#stats.outbound += 1
        await sendTextMessage({
          baseUrl: accountNow.baseUrl,
          token: accountNow.token,
          to: userId,
          text: body,
          clientId: `dsh-wechat-${randomUUID()}`,
          contextToken: token,
        })
      }

      // 斜杠指令：不进入 Agent，直接由插件处理。
      if (text.startsWith('/')) {
        try {
          const handled = await this.#runCommand(accountNow, userId, text, replyPlain)
          if (handled) return
        } catch (error) {
          this.#log(`处理微信指令失败：${String(error?.message ?? error)}`)
          await replyPlain(`指令执行失败：${String(error?.message ?? error)}`).catch(() => undefined)
          return
        }
      }

      await this.#sendTyping(accountNow, userId, token, true).catch(() => undefined)
      try {
        const registry = await this.#loadRegistry()
        const currentName = this.#currentAgentName(userId)
        const profile = agentNamed(registry, currentName)
        const outcome = await this.#bridge.ask({
          sessionId: this.#sessionFor(userId, profile.name),
          text,
          profile,
        })
        this.#sessions.set(this.#sessionKey(userId, profile.name), outcome.sessionId)
        const kind = outcome.reason?.kind
        const body =
          typeof outcome.text === 'string' && outcome.text.trim() !== ''
            ? toWeChatPlainText(outcome.text)
            : kind === 'timeout'
              ? '任务还在执行，稍后我再看结果。你也可以在 DSH 里查看进度。'
              : kind === 'error'
                ? `执行失败：${outcome.reason?.error?.message ?? '未知错误'}`
                : '已执行完成，但没有可显示的文字输出。'
        this.#stats.outbound += 1
        await sendTextMessage({
          baseUrl: accountNow.baseUrl,
          token: accountNow.token,
          to: userId,
          text: body,
          clientId: `dsh-wechat-${randomUUID()}`,
          contextToken: token,
        })
      } catch (error) {
        const detail = String(error?.message ?? error)
        this.#stats.lastError = detail
        this.#log(`回复微信消息失败：${detail}`)
        await sendTextMessage({
          baseUrl: accountNow.baseUrl,
          token: accountNow.token,
          to: userId,
          text: `处理失败了：${detail}`,
          clientId: `dsh-wechat-${randomUUID()}`,
          contextToken: token,
        }).catch(() => undefined)
      } finally {
        await this.#sendTyping(accountNow, userId, token, false).catch(() => undefined)
      }
    })
  }

  /**
   * 处理一条微信斜杠指令。
   *
   * @param account - 当前账号。
   * @param userId - 发送者。
   * @param text - 指令原文。
   * @param reply - 回一条纯文本。
   * @returns 是否已处理该指令（未识别则返回 false，交回 Agent）。
   */
  async #runCommand(account, userId, text, reply) {
    const [rawCommand, ...rest] = text.split(/\s+/)
    const command = rawCommand.toLowerCase()
    const argument = rest.join(' ').trim()
    const registry = await this.#loadRegistry()

    switch (command) {
      case '/help':
      case '/帮助': {
        await reply(
          [
            '可用指令：',
            '/agents — 列出所有 Agent，* 标记当前使用的',
            '/use <名字> — 切换到某个 Agent',
            '/models [provider] — 列出可用的模型',
            '/model <provider>/<model> — 给当前 Agent 选定模型',
            '/new — 结束当前对话，开始新的',
            '/status — 查看当前 Agent、模型与会话',
          ].join('\n'),
        )
        return true
      }
      case '/agents':
      case '/agent':
      case '/代理': {
        const current = this.#currentAgentName(userId)
        const lines = registry.agents.map((agent) => {
          const mark = agent.name === current ? '*' : ' '
          const model = agent.model === '' ? '（宿主默认模型）' : `${agent.provider}/${agent.model}`
          const preset = agent.preset === '' ? '（宿主默认 preset）' : agent.preset
          return `${mark} ${agent.name} — ${model}，${preset}`
        })
        await reply(`Agent 列表（* 是当前使用的）：\n${lines.join('\n')}\n\n用 /use <名字> 切换。`)
        return true
      }
      case '/use':
      case '/切换': {
        if (argument === '') {
          await reply('用法：/use <名字>。用 /agents 查看有哪些 Agent。')
          return true
        }
        const target = registry.agents.find((agent) => agent.name === argument)
        if (target === undefined) {
          await reply(`没有名为「${argument}」的 Agent。用 /agents 查看有哪些。`)
          return true
        }
        this.#currentAgents.set(userId, target.name)
        await reply(`已切换到 Agent「${target.name}」。它的上下文是独立的。`)
        return true
      }
      case '/models':
      case '/模型': {
        const catalog = await listCatalog(this.#ctx)
        if (catalog.providers.length === 0) {
          await reply('当前部署没有可用的模型目录。')
          return true
        }
        const lines = []
        for (const provider of catalog.providers) {
          if (argument !== '' && provider.id !== argument) continue
          const models = provider.models.map((model) => model.id).join(', ')
          lines.push(`${provider.id}（${provider.name}）：${models === '' ? '（没有模型）' : models}`)
        }
        if (lines.length === 0) {
          await reply(`没有找到 provider「${argument}」。`)
          return true
        }
        await reply(`可用模型：\n${lines.join('\n')}\n\n用 /model <provider>/<model> 选定。`)
        return true
      }
      case '/model': {
        if (argument === '') {
          const current = this.#currentAgentName(userId)
          const profile = agentNamed(registry, current)
          await reply(
            profile.model === ''
              ? '当前 Agent 使用宿主的默认模型。用 /model <provider>/<model> 选定一个。'
              : `当前 Agent「${profile.name}」使用 ${profile.provider}/${profile.model}。`,
          )
          return true
        }
        const slash = argument.lastIndexOf('/')
        if (slash <= 0 || slash === argument.length - 1) {
          await reply('用法：/model <provider>/<model>。用 /models 查看可用模型。')
          return true
        }
        const provider = argument.slice(0, slash)
        const model = argument.slice(slash + 1)
        const check = await checkModel(this.#ctx, provider, model)
        if (!check.ok) {
          await reply(`选定失败：${check.reason}`)
          return true
        }
        const current = this.#currentAgentName(userId)
        const profile = agentNamed(registry, current)
        await upsertAgent({ ...profile, provider, model })
        await reply(`Agent「${profile.name}」已改用 ${provider}/${model}。`)
        return true
      }
      case '/new':
      case '/新会话': {
        const current = this.#currentAgentName(userId)
        this.#resetSession(userId, current)
        await reply('已开始新的对话。请直接说出你的需求。')
        return true
      }
      case '/status':
      case '/状态': {
        const current = this.#currentAgentName(userId)
        const profile = agentNamed(registry, current)
        const sessionId = this.#sessionFor(userId, profile.name)
        await reply(
          [
            `当前 Agent：${profile.name}`,
            `模型：${profile.model === '' ? '（宿主默认）' : `${profile.provider}/${profile.model}`}`,
            `preset：${profile.preset === '' ? '（宿主默认）' : profile.preset}`,
            `会话：${sessionId ?? '（尚未开始）'}`,
            `已收消息：${this.#stats.inbound}，已回消息：${this.#stats.outbound}`,
          ].join('\n'),
        )
        return true
      }
      default:
        return false
    }
  }

  /** 载入 Agent 注册表（带缓存，避免每条消息都读盘）。 */
  async #loadRegistry() {
    if (this.#registryCache !== undefined) return this.#registryCache
    this.#registryCache = await loadAgents()
    return this.#registryCache
  }

  /** 注册表变了就丢掉缓存。 */
  invalidateRegistry() {
    this.#registryCache = undefined
  }

  /** 某个用户当前使用的 Agent 名字。 */
  #currentAgentName(userId) {
    return this.#currentAgents.get(userId) ?? this.#registryCache?.defaultName ?? 'default'
  }

  /** 会话映射的键：一个用户在一个 Agent 下的会话。 */
  #sessionKey(userId, agentName) {
    return `${userId}::${agentName}`
  }


  /** 新会话的工作目录：插件配置优先，否则沿用宿主默认目录。 */
  #cwd() {
    const configured = this.#options.cwd?.()
    if (typeof configured === 'string' && configured !== '') return configured
    try {
      return this.#ctx.workingDirectory?.defaultDirectory
    } catch {
      return undefined
    }
  }

  /**
   * 用 `/new` 清掉某个用户在某个 Agent 下的对话绑定，下次消息会开一个新 Session。
   *
   * @param userId - 微信用户。
   * @param agentName - Agent 名；省略时清掉该用户的所有会话。
   * @returns 被清掉的 session id。
   */
  #resetSession(userId, agentName) {
    if (agentName === undefined) {
      const cleared = []
      for (const key of [...this.#sessions.keys()]) {
        if (key.startsWith(`${userId}::`)) {
          cleared.push(this.#sessions.get(key))
          this.#sessions.delete(key)
        }
      }
      return cleared[0]
    }
    const key = this.#sessionKey(userId, agentName)
    const sessionId = this.#sessions.get(key)
    this.#sessions.delete(key)
    return sessionId
  }

  /**
   * 取某个用户在某个 Agent 下的 Session id。
   *
   * @param userId - 微信用户。
   * @param agentName - Agent 名。
   * @returns session id，或 undefined。
   */
  #sessionFor(userId, agentName) {
    return this.#sessions.get(this.#sessionKey(userId, agentName))
  }

  /**
   * 发“正在输入”。typing_ticket 需要先向服务端申请（按用户缓存 24 小时），
   * 失败静默忽略——它只是体验细节，不能影响回复本身。
   *
   * @param account - 当前账号。
   * @param userId - 目标用户。
   * @param contextToken - 本会话的 context_token。
   * @param typing - true=输入中，false=取消。
   */
  async #sendTyping(account, userId, contextToken, typing) {
    let ticket = this.#typingTickets.get(userId)
    if (ticket === undefined || Date.now() - ticket.fetchedAt > 24 * 60 * 60_000) {
      const config = await getBotConfig({
        baseUrl: account.baseUrl,
        token: account.token,
        ilinkUserId: userId,
        contextToken,
      })
      if (typeof config.typing_ticket !== 'string' || config.typing_ticket === '') return
      ticket = { ticket: config.typing_ticket, fetchedAt: Date.now() }
      this.#typingTickets.set(userId, ticket)
    }
    await sendTyping({
      baseUrl: account.baseUrl,
      token: account.token,
      ilinkUserId: userId,
      typingTicket: ticket.ticket,
      status: typing ? 1 : 2,
    })
  }
}

/**
 * 可被信号打断的 sleep。
 *
 * @param ms - 毫秒。
 * @param signal - 取消信号。
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve()
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
