/**
 * 微信 ClawBot 通道协议（iLink Bot API）。
 *
 * 依据 @tencent-weixin/openclaw-weixin 的公开实现复刻，只保留“文字收发 + 扫码登录”
 * 这条主链路：get_bot_qrcode / get_qrcode_status 扫码登录，ilink/bot/getupdates 长轮询
 * 收消息，ilink/bot/sendmessage 回消息。所有请求都带 base_info，其中 bot_agent 仅用于
 * 服务端观测，不参与鉴权。
 *
 * @module dsh-wechat-assistant/weixin
 */

/** 扫码与登录请求的固定入口。 */
export const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** 本通道构建对应的 ilink bot_type（与官方通道一致）。 */
export const DEFAULT_BOT_TYPE = '3'

/** 会话失效错误码：收到后服务端要求冷却一小时。 */
export const STALE_TOKEN_ERRCODE = -14

/** 长轮询默认超时；服务端可用 longpolling_timeout_ms 覆盖。 */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000
/** 普通 API 默认超时。 */
const DEFAULT_API_TIMEOUT_MS = 15_000
/** 轻量 API（getconfig / sendtyping）默认超时。 */
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000

/** 消息类型：1=用户，2=bot。 */
export const MessageType = { NONE: 0, USER: 1, BOT: 2 }
/** 消息体类型：1=文字，2=图片，3=语音，4=文件，5=视频。 */
export const MessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 }
/** 消息状态：finished 才是一条完整消息。 */
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 }

const CHANNEL_VERSION = '1.0.0'
const DEFAULT_BOT_AGENT = 'DSH-WeChat-Assistant'
const BOT_AGENT_MAX_LEN = 256

/**
 * 把自定义 botAgent 清洗成 UA 风格的安全字符串。
 *
 * 语法：`Name/Version` token 以空格分隔，每个 token 后可跟一个 `(comment)`；
 * 只允许 ASCII，总长 ≤256 字节。不合规的 token 静默丢弃，全空时回退到默认值。
 *
 * @param raw - 用户配置的原始值。
 * @returns 可直接上线的 bot_agent。
 */
export function sanitizeBotAgent(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_BOT_AGENT
  const tokens = raw.trim().split(/\s+/)
  const productRe = /^[A-Za-z0-9_.\-]{1,32}\/[A-Za-z0-9_.+\-]{1,32}$/
  const commentCharRe = /^[\x20-\x27\x2A-\x7E]{1,64}$/
  const accepted = []
  let pending = null
  for (const token of tokens) {
    if (token.startsWith('(')) {
      const inner = token.replace(/^\(|\)$/g, '')
      if (pending !== null && commentCharRe.test(inner)) {
        accepted.push(`${pending} (${inner})`)
        pending = null
      }
      continue
    }
    if (pending !== null) {
      accepted.push(pending)
      pending = null
    }
    if (productRe.test(token)) pending = token
  }
  if (pending !== null) accepted.push(pending)
  if (accepted.length === 0) return DEFAULT_BOT_AGENT
  const joined = accepted.join(' ')
  if (Buffer.byteLength(joined, 'utf8') <= BOT_AGENT_MAX_LEN) return joined
  const kept = []
  let length = 0
  for (const token of accepted) {
    const add = (kept.length === 0 ? 0 : 1) + Buffer.byteLength(token, 'utf8')
    if (length + add > BOT_AGENT_MAX_LEN) break
    kept.push(token)
    length += add
  }
  return kept.length > 0 ? kept.join(' ') : DEFAULT_BOT_AGENT
}

/** 组装每个请求都携带的 base_info。 */
export function buildBaseInfo(botAgent) {
  return { channel_version: CHANNEL_VERSION, bot_agent: sanitizeBotAgent(botAgent) }
}

function ensureTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`
}

/**
 * 把 fetch 层错误分类，便于在设置页给出可读原因（DNS / TCP / TLS / 超时）。
 *
 * @param error - 捕获到的异常。
 * @returns 分类结果。
 */
export function classifyFetchError(error) {
  if (error instanceof Error && error.name === 'AbortError') {
    return { type: 'timeout', description: '请求超时' }
  }
  const cause = error?.cause
  const code = cause?.code ?? ''
  const haystack = `${String(cause ?? error)} ${String(code)}`
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(haystack)) return { type: 'dns', description: 'DNS 解析失败', code }
  if (/ECONNREFUSED/i.test(haystack)) return { type: 'tcp', description: '连接被拒绝', code }
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(haystack)) {
    return { type: 'tcp', description: '连接超时或网络不可达', code }
  }
  if (/UND_ERR_SOCKET|SSL|TLS|CERT|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(haystack)) {
    return { type: 'tls', description: 'TLS 握手失败', code }
  }
  return { type: 'unknown', description: '网络请求失败', code }
}

/**
 * 带超时的 fetch，返回响应文本。
 *
 * @param params - 目标、方法、请求体、超时与外部取消信号。
 * @returns 响应原文。
 */
async function requestText(params) {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), params.timeoutMs)
  const onAbort = () => controller.abort()
  params.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url.toString(), {
      method: params.method ?? 'POST',
      headers: params.headers ?? {},
      ...(params.body === undefined ? {} : { body: params.body }),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${params.label} HTTP ${response.status}: ${text.slice(0, 300)}`)
    return text
  } finally {
    clearTimeout(timer)
    params.signal?.removeEventListener('abort', onAbort)
  }
}

function commonHeaders(routeTag) {
  const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '65547' }
  if (typeof routeTag === 'string' && routeTag !== '') headers.SKRouteTag = routeTag
  return headers
}

function authorizedHeaders(token, routeTag) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(Math.floor(Math.random() * 0xffffffff)), 'utf8').toString('base64'),
    ...commonHeaders(routeTag),
  }
  if (typeof token === 'string' && token.trim() !== '') headers.Authorization = `Bearer ${token.trim()}`
  return headers
}

/**
 * 请求一个登录二维码。
 *
 * @param params - 底座地址、bot_type 与本地已有 token（用于服务端判断“已绑定”）。
 * @returns `{ qrcode, qrcode_img_content }`，后者是可直接渲染成二维码的链接。
 */
export async function fetchLoginQrCode(params) {
  const text = await requestText({
    baseUrl: params.baseUrl ?? FIXED_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(params.botType ?? DEFAULT_BOT_TYPE)}`,
    body: JSON.stringify({ local_token_list: params.localTokenList ?? [] }),
    headers: { 'Content-Type': 'application/json', ...commonHeaders(params.routeTag) },
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: 'get_bot_qrcode',
    signal: params.signal,
  })
  return JSON.parse(text)
}

/**
 * 长轮询扫码状态。客户端超时是正常控制流，按 `wait` 返回而不是抛错。
 *
 * @param params - 二维码与可选的配对数字。
 * @returns 状态响应；网络错误同样折叠成 `{ status: 'wait' }`。
 */
export async function pollLoginQrStatus(params) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`
  if (typeof params.verifyCode === 'string' && params.verifyCode !== '') {
    endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`
  }
  try {
    const text = await requestText({
      baseUrl: params.baseUrl,
      endpoint,
      method: 'GET',
      headers: commonHeaders(params.routeTag),
      timeoutMs: 35_000,
      label: 'get_qrcode_status',
      signal: params.signal,
    })
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { status: 'wait' }
    return { status: 'wait', softError: String(error?.message ?? error) }
  }
}

/**
 * 长轮询收消息。客户端超时返回空响应，调用方直接重试即可。
 *
 * @param params - 账号凭据、续传游标与超时。
 * @returns getUpdates 响应。
 */
export async function getUpdates(params) {
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS
  try {
    const text = await requestText({
      baseUrl: params.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: params.getUpdatesBuf ?? '',
        base_info: buildBaseInfo(params.botAgent),
      }),
      headers: authorizedHeaders(params.token, params.routeTag),
      timeoutMs: timeout,
      label: 'getUpdates',
      signal: params.signal,
    })
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError' && params.signal?.aborted !== true) {
      return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf }
    }
    throw error
  }
}

/**
 * 发送一条 bot 消息给指定微信用户。
 *
 * @param params - 账号凭据、收件人、正文与需要回带的 context_token。
 * @returns 服务端响应（含 message_id）。
 */
export async function sendTextMessage(params) {
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: params.to,
      client_id: params.clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: params.text } }],
      ...(params.contextToken === undefined || params.contextToken === ''
        ? {}
        : { context_token: params.contextToken }),
      ...(params.runId === undefined ? {} : { run_id: params.runId }),
    },
  }
  const text = await requestText({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify({ ...body, base_info: buildBaseInfo(params.botAgent) }),
    headers: authorizedHeaders(params.token, params.routeTag),
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: 'sendmessage',
    signal: params.signal,
  })
  const response = JSON.parse(text)
  if (typeof response.ret === 'number' && response.ret !== 0) {
    throw new Error(`sendmessage ret=${response.ret} errmsg=${response.errmsg ?? '(none)'}`)
  }
  return response
}

/**
 * 取 bot 对该用户的配置（目前只需要 typing_ticket）。
 *
 * @param params - 账号凭据与目标用户。
 * @returns getConfig 响应。
 */
export async function getBotConfig(params) {
  const text = await requestText({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/getconfig',
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      ...(params.contextToken === undefined ? {} : { context_token: params.contextToken }),
      base_info: buildBaseInfo(params.botAgent),
    }),
    headers: authorizedHeaders(params.token, params.routeTag),
    timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'getconfig',
    signal: params.signal,
  })
  return JSON.parse(text)
}

/**
 * 发送“正在输入”状态。
 *
 * @param params - 目标用户、typing_ticket 与状态码（1=输入中，2=取消）。
 */
export async function sendTyping(params) {
  await requestText({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      typing_ticket: params.typingTicket,
      status: params.status ?? 1,
      base_info: buildBaseInfo(params.botAgent),
    }),
    headers: authorizedHeaders(params.token, params.routeTag),
    timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'sendtyping',
    signal: params.signal,
  })
}

/**
 * 通知服务端本通道正在启动或停止。
 *
 * @param params - 账号凭据与方向。
 */
export async function notifyLifecycle(params) {
  await requestText({
    baseUrl: params.baseUrl,
    endpoint: params.stopping ? 'ilink/bot/msg/notifystop' : 'ilink/bot/msg/notifystart',
    body: JSON.stringify({ base_info: buildBaseInfo(params.botAgent) }),
    headers: authorizedHeaders(params.token, params.routeTag),
    timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
    label: params.stopping ? 'notifystop' : 'notifystart',
    signal: params.signal,
  })
}

/**
 * 从一条入站消息里取出正文：文字优先，语音用微信侧的转写结果，其余媒体给占位标签。
 *
 * @param message - getUpdates 返回的一条消息。
 * @returns 可送入模型的正文。
 */
export function messageBody(message) {
  for (const item of message.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && typeof item.text_item?.text === 'string') return item.text_item.text
    if (item.type === MessageItemType.VOICE && typeof item.voice_item?.text === 'string') return item.voice_item.text
  }
  const media = (message.item_list ?? []).find((item) => [2, 3, 4, 5].includes(item.type))
  if (media === undefined) return ''
  return media.type === MessageItemType.IMAGE
    ? '[图片]'
    : media.type === MessageItemType.VOICE
      ? '[语音]'
      : media.type === MessageItemType.FILE
        ? '[文件]'
        : '[视频]'
}
