/**
 * 插件自己的落盘状态：账号凭据、长轮询游标、每用户 context_token。
 *
 * 全部放在 DSH home 下的 `wechat-assistant/` 里，不碰 profile 的 package.json
 * 或 cordis.patch.yml。凭据文件权限收紧到 0600。
 *
 * @module dsh-wechat-assistant/store
 */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * 解析状态目录。优先 DSH_HOME，其次 ~/.dsh，与宿主其它插件一致。
 *
 * @returns 插件私有的状态目录绝对路径。
 */
export function stateDir() {
  const home = process.env.DSH_HOME?.trim()
  const root = home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
  return join(root, 'wechat-assistant')
}

function accountPath(accountId) {
  return join(stateDir(), 'accounts', `${accountId}.json`)
}

function syncBufPath(accountId) {
  return join(stateDir(), 'accounts', `${accountId}.sync.json`)
}

function contextTokenPath(accountId) {
  return join(stateDir(), 'accounts', `${accountId}.context-tokens.json`)
}

function settingsPath() {
  return join(stateDir(), 'settings.json')
}

/**
 * 原子写 JSON：先写临时文件再 rename，避免半截文件。
 *
 * @param path - 目标文件。
 * @param value - 可 JSON 序列化的值。
 * @param secret - 是否按凭据收紧权限。
 */
async function writeJson(path, value, secret = false) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
  if (secret) {
    try {
      await chmod(temp, 0o600)
    } catch {
      // Windows 上 chmod 基本无效，失败不影响功能。
    }
  }
  await rename(temp, path)
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 读插件自己的设置（目前只有上次登录的账号）。
 *
 * @returns `{ accountId }`，缺失时为空串。
 */
export async function loadSettings() {
  const value = await readJson(settingsPath())
  return { accountId: typeof value?.accountId === 'string' ? value.accountId : '' }
}

/**
 * 合并写入插件设置。
 *
 * @param patch - 要覆盖的字段。
 */
export async function saveSettings(patch) {
  const current = await loadSettings()
  await writeJson(settingsPath(), { ...current, ...patch })
}

/**
 * 读一个账号的凭据。
 *
 * @param accountId - ilink bot id。
 * @returns 凭据，缺失或损坏时为 undefined。
 */
export async function loadAccount(accountId) {
  return readJson(accountPath(accountId))
}

/**
 * 写一个账号的凭据（token / baseUrl / userId 合并写入）。
 *
 * @param accountId - ilink bot id。
 * @param update - 要覆盖的字段。
 */
export async function saveAccount(accountId, update) {
  const existing = (await loadAccount(accountId)) ?? {}
  const token = update.token?.trim() || existing.token
  const baseUrl = update.baseUrl?.trim() || existing.baseUrl
  const userId = update.userId?.trim() || existing.userId
  await writeJson(
    accountPath(accountId),
    {
      ...(token === undefined ? {} : { token, savedAt: new Date().toISOString() }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(userId === undefined ? {} : { userId }),
    },
    true,
  )
}

/**
 * 删除一个账号的全部本地状态。
 *
 * @param accountId - ilink bot id。
 */
export async function clearAccount(accountId) {
  for (const path of [accountPath(accountId), syncBufPath(accountId), contextTokenPath(accountId)]) {
    try {
      await unlink(path)
    } catch {
      // 不存在即视为已清理。
    }
  }
}

/**
 * 读长轮询续传游标。
 *
 * @param accountId - ilink bot id。
 * @returns 游标字符串，缺失时为空串。
 */
export async function loadSyncBuf(accountId) {
  const value = await readJson(syncBufPath(accountId))
  return typeof value?.buf === 'string' ? value.buf : ''
}

/**
 * 写长轮询续传游标。
 *
 * @param accountId - ilink bot id。
 * @param buf - 服务端下发的完整游标。
 */
export async function saveSyncBuf(accountId, buf) {
  if (typeof buf !== 'string' || buf === '') return
  await writeJson(syncBufPath(accountId), { buf, savedAt: new Date().toISOString() })
}

/**
 * 读某账号下所有用户的 context_token。
 *
 * @param accountId - ilink bot id。
 * @returns 用户 id 到 token 的映射。
 */
export async function loadContextTokens(accountId) {
  const value = await readJson(contextTokenPath(accountId))
  return value !== null && typeof value === 'object' ? value : {}
}

/**
 * 记录一个用户的 context_token（回复时必须原样带回）。
 *
 * @param accountId - ilink bot id。
 * @param userId - 微信用户 id。
 * @param token - 本消息下发的 token。
 */
export async function saveContextToken(accountId, userId, token) {
  if (typeof token !== 'string' || token === '') return
  const current = await loadContextTokens(accountId)
  if (current[userId] === token) return
  current[userId] = token
  await writeJson(contextTokenPath(accountId), current, true)
}
