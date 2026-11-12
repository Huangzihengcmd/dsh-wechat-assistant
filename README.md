# dsh-wechat-assistant

**在微信里直接指挥 DeepSeek Harness。** 扫码登录一次，之后在微信聊天窗口发指令，DSH 在这台电脑上执行，结果实时回传到同一个聊天窗口。

A DeepSeek Harness (DSH) plugin that bridges your WeChat account to the agent running on your PC. Scan a QR code once, then send instructions from WeChat and get results back in the same chat.

---

## 这是什么

微信官方为 Agent 生态提供的 **微信 ClawBot** 通道（Tencent 官方发布的 `@tencent-weixin/openclaw-weixin`）。本插件是 DSH 侧的接入实现：

- **扫码登录** —— 微信扫码授权，无需公网服务器、无需手动复制 token
- **长轮询收消息** —— 通道在 DSH 进程内长轮询微信服务端，不占用端口
- **执行与回传** —— 微信消息进入一个 DSH Session，跑完一轮把正文发回微信

基于腾讯官方 iLink Bot 协议实现（`get_bot_qrcode` / `get_qrcode_status` / `getupdates` / `sendmessage`），二维码在浏览器本地渲染，不引入任何外部资源。

## 安装

### 从 GitHub 安装（推荐）

```bash
dsh plugin add Huangzihengcmd/dsh-wechat-assistant
```

### 在 DSH 界面里

Plugins 页面 → 添加插件 → 填入仓库地址 `Huangzihengcmd/dsh-wechat-assistant`。

## 使用

1. 打开 **设置 → 微信助理**。页面打开时会自动生成登录二维码。
2. 用**手机微信**扫描二维码，在手机上确认授权。
   - 若手机提示输入数字配对码，把它填进页面上的输入框。
3. 卡片显示「已连接」后，在微信里直接发指令即可。

### 指令

普通自然语言即可，例如：

```
帮我看一下这个项目有哪些测试没跑
把这个目录里的 CSV 汇总成一张表
```

`/new`（或 `/新会话`）会结束当前对话、开启一个新的 DSH Session。

### 二维码过期

二维码有时效。过期后页面会提示，点「**刷新二维码**」换一张新的即可。Host 侧也会自动换发（最多 3 次）。

## 访问控制（重要）

**只有配置的主人微信账号能驱动 Agent；其他发送者默认拒绝，需显式审批。**

- 第一次扫码登录的微信账号会被记为**主人**。
- 白名单为空时，**任何陌生人的消息都不会被执行**——不创建 Session、不调用 Agent、不碰工具。
- 陌生人发消息只会进入「待审批」列表，并收到一条提示；你在**设置 → 微信助理 → 访问控制**里点「批准」之后，他才能驱动 Agent。
- 「撤销」随时收回某个已批准账号的权限。
- 主人不能被后来扫码的人顶替。

授权状态存在 `<DSH_HOME>/wechat-assistant/allowlist.json`。

## 工作方式

```
微信 App  ⇄  微信 ClawBot 服务  ⇄  本插件（长轮询）⇄  DSH Agent
```

每个微信用户对应一个 DSH Session，会话在插件自己的状态目录里持久化：

| 路径 | 内容 |
|---|---|
| `<DSH_HOME>/wechat-assistant/accounts/<id>.json` | 账号凭据（token，权限 0600） |
| `<DSH_HOME>/wechat-assistant/accounts/<id>.sync.json` | 长轮询续传游标 |
| `<DSH_HOME>/wechat-assistant/accounts/<id>.context-tokens.json` | 各用户的 context_token |
| `<DSH_HOME>/wechat-assistant/allowlist.json` | 主人、已批准与待审批的微信用户 |

默认 `<DSH_HOME>` 为 `~/.dsh`。

## 配置

插件行配置（Plugins 页面或 profile 的 `cordis.patch.yml`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `autoConnect` | `true` | 启动时自动接上上次登录的账号 |
| `cwd` | 空 | 新会话的工作目录；留空则用 DSH 默认目录 |

## 隐私与安全

- **入站默认拒绝**：只有主人和已批准的微信账号能驱动 Agent。陌生人的消息不会创建 Session、不会调用 Agent、不会触碰工具集——详见上面的「访问控制」。
- 微信凭据只存在你的机器上，**不会**发给浏览器，也不会发给 DSH 之外的任何地方。
- HTTP 路由只接受**本机**（loopback）请求。
- 消息内容会进入 DSH 的会话日志——它和网页端对话一样，是可追溯的。

## 兼容性

需要 DSH `>=0.2.1-rc.5`（`ctx.agents.create/resume`、`agent.followup()`、`agent.whenIdle()`、`settings.section` 槽位）。

## 许可证

MIT
