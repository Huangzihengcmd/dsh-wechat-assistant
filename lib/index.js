/**
 * 微信助理 Host 插件。
 *
 * 两件事：给设置页提供一组同源 HTTP 路由（状态、扫码登录、连接/断开），
 * 以及持有通道与桥的生命周期。所有网络调用都在 Host 进程里，浏览器的
 * 那一半只看状态、拿二维码链接。凭据与账号留在插件自己的状态目录里，
 * 不写宿主 profile 的 package.json 或 cordis.patch.yml。
 *
 * @module dsh-wechat-assistant
 */
import { WeChatAgentBridge } from './bridge.js'
import { WeChatChannel } from './channel.js'
import { clearAccount, loadSettings, saveSettings } from './store.js'

/** 路由前缀：与 Client 半写死的常量保持一致。 */
const ROUTE_PREFIX = '/plugins/dsh-wechat-assistant'

/**
 * 依赖：`webServer` 提供路由，`agents` 提供 Session。
 */
export const inject = ['webServer', 'agents']

/**
 * 读 JSON 请求体。
 *
 * @param req - Node 请求对象。
 * @returns 解析后的对象，空体返回 `{}`。
 */
async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

/**
 * 回一个 JSON 响应。
 *
 * @param res - Node 响应对象。
 * @param status - HTTP 状态码。
 * @param body - 可 JSON 序列化的响应体。
 */
function json(res, status, body) {
  const payload = JSON.stringify(body ?? {})
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * 只接受本机来源：这些路由能碰到微信凭据，不对局域网开放。
 *
 * @param req - Node 请求对象。
 * @returns 是否允许。
 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 插件入口。
 *
 * @param ctx - Cordis 上下文。
 * @param config - 本行配置。
 */
export function apply(ctx, config) {
  const log = (message) => ctx.logger.info(`[微信助理] ${message}`)
  const bridge = new WeChatAgentBridge(ctx, log)
  const channel = new WeChatChannel(ctx, log, bridge, {
    cwd: () => (typeof config?.cwd === 'string' && config.cwd.trim() !== '' ? config.cwd.trim() : undefined),
  })

  ctx.effect(() => () => {
    void channel.stop()
    void bridge.dispose()
  }, 'dsh-wechat-assistant/lifecycle')

  const disposers = []
  const route = (path, handler) => {
    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}${path}`,
        handler: async (req, res) => {
          if (!isLoopback(req)) return json(res, 403, { error: '仅允许本机访问' })
          try {
            await handler(req, res)
          } catch (error) {
            ctx.logger.warn(`[微信助理] ${path} 处理失败：${String(error)}`)
            json(res, 500, { error: String(error?.message ?? error) })
          }
        },
      }),
    )
  }

  /** 状态：连接态、账号、登录进度与收发计数。 */
  route('/state', async (req, res) => {
    const settings = await loadSettings()
    json(res, 200, {
      ...channel.snapshot(),
      accountId: channel.account?.accountId ?? settings.accountId,
      configured: (channel.account?.accountId ?? settings.accountId) !== '',
      autoConnect: config?.autoConnect !== false,
    })
  })

  /** 发起扫码登录，返回二维码链接给页面渲染。 */
  route('/login/start', async (req, res) => {
    const result = await channel.beginLogin()
    json(res, 200, result)
  })

  /** 强制换一张新二维码：作废当前码，重新向微信要一张。 */
  route('/login/refresh', async (req, res) => {
    const result = await channel.refreshLogin()
    json(res, 200, result)
  })

  /** 提交手机微信上显示的数字配对码。 */
  route('/login/verify', async (req, res) => {
    const body = await readJsonBody(req)
    channel.submitVerifyCode(body.code)
    json(res, 200, { ok: true })
  })

  /** 放弃本次扫码。 */
  route('/login/cancel', async (req, res) => {
    channel.cancelLogin()
    json(res, 200, { ok: true })
  })

  /** 连接：有凭据就重连，没有就提示先扫码。 */
  route('/connect', async (req, res) => {
    if (channel.account === undefined) {
      const settings = await loadSettings()
      if (settings.accountId !== '') await channel.restore(settings.accountId)
    }
    const ok = await channel.start()
    json(res, 200, { ok, ...channel.snapshot() })
  })

  /** 断开连接，但保留凭据，下次可一键重连。 */
  route('/disconnect', async (req, res) => {
    await channel.stop()
    json(res, 200, { ok: true, ...channel.snapshot() })
  })

  /** 取消连接：断开并删除本地凭据。 */
  route('/signout', async (req, res) => {
    const settings = await loadSettings()
    const accountId = channel.account?.accountId ?? settings.accountId
    await channel.signOut()
    if (accountId !== '') await clearAccount(accountId)
    await saveSettings({ accountId: '' })
    json(res, 200, { ok: true, ...channel.snapshot() })
  })

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'dsh-wechat-assistant/routes')

  // 登录成功后把 accountId 记进插件自己的状态目录，重启即可自动重连。
  const unsubscribeAccount = channel.onAccountChanged((accountId) => {
    void saveSettings({ accountId })
  })
  ctx.effect(() => () => unsubscribeAccount(), 'dsh-wechat-assistant/account-persist')

  // 默认自动重连；本行配置里写 `autoConnect: false` 可以关掉。
  if (config?.autoConnect !== false) {
    void (async () => {
      try {
        const settings = await loadSettings()
        if (settings.accountId === '') return
        await channel.restore(settings.accountId)
        await channel.start()
      } catch (error) {
        ctx.logger.warn(`[微信助理] 自动恢复连接失败：${String(error)}`)
      }
    })()
  }
}
