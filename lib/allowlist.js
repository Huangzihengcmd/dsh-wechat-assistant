/**
 * 入站发送者授权：主人白名单 + 陌生人显式审批。
 *
 * 默认姿态是**拒绝**：白名单为空时，任何陌生人都不能驱动本机 Agent。陌生人
 * 可以发消息来「申请」，但申请只进入待审批列表，必须由本机用户在设置页里
 * 明确批准后才会生效。
 *
 * @module dsh-wechat-assistant/allowlist
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { stateDir } from './store.js'

function listPath() {
  return join(stateDir(), 'allowlist.json')
}

/**
 * 读取当前授权状态。
 *
 * @returns `{ owner, allowed, pending }`：主人 id、已批准列表、待审批列表。
 */
export async function loadAllowlist() {
  let raw
  try {
    raw = JSON.parse(await readFile(listPath(), 'utf8'))
  } catch {
    return { owner: '', allowed: [], pending: [] }
  }
  const asList = (value) =>
    Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []
  return {
    owner: typeof raw?.owner === 'string' ? raw.owner : '',
    allowed: asList(raw?.allowed),
    pending: asList(raw?.pending),
  }
}

/**
 * 写回授权状态。
 *
 * @param value - 要保存的完整状态。
 */
async function saveAllowlist(value) {
  const path = listPath()
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
  try {
    await chmod(temp, 0o600)
  } catch {
    // Windows 上 chmod 基本无效。
  }
  await rename(temp, path)
}

/**
 * 合并写入授权状态。
 *
 * @param patch - 要覆盖的字段。
 * @returns 写入后的完整状态。
 */
export async function updateAllowlist(patch) {
  const current = await loadAllowlist()
  const next = { ...current, ...patch }
  await saveAllowlist(next)
  return next
}

/**
 * 判断一个发送者当前能否驱动 Agent。
 *
 * @param allowlist - 当前授权状态。
 * @param userId - 微信发送者 id。
 * @returns `'owner'` | `'allowed'` | `'pending'`。
 */
export function verdictOf(allowlist, userId) {
  if (typeof userId !== 'string' || userId === '') return 'pending'
  if (allowlist.owner !== '' && allowlist.owner === userId) return 'owner'
  if (allowlist.allowed.includes(userId)) return 'allowed'
  return 'pending'
}

/**
 * 首次扫码登录时，把扫码人记为默认主人。
 *
 * 只有在还没有主人时才会写入——已经设过主人的账号不会被扫码者顶替。
 *
 * @param userId - 扫码人的微信 user id。
 * @returns 写入后的授权状态。
 */
export async function claimOwnerIfUnset(userId) {
  if (typeof userId !== 'string' || userId === '') return loadAllowlist()
  const current = await loadAllowlist()
  if (current.owner !== '') return current
  return updateAllowlist({ owner: userId })
}

/**
 * 把一个陌生人从「待审批」移进「已批准」。
 *
 * @param userId - 要批准的微信 user id。
 * @returns 写入后的授权状态。
 */
export async function approve(userId) {
  if (typeof userId !== 'string' || userId === '') throw new Error('缺少要批准的微信用户 id')
  const current = await loadAllowlist()
  const allowed = current.allowed.includes(userId) ? current.allowed : [...current.allowed, userId]
  const pending = current.pending.filter((item) => item !== userId)
  return updateAllowlist({ allowed, pending })
}

/**
 * 撤销一个已批准的用户，并把它退回待审批列表。
 *
 * @param userId - 要撤销的微信 user id。
 * @returns 写入后的授权状态。
 */
export async function revoke(userId) {
  const current = await loadAllowlist()
  const allowed = current.allowed.filter((item) => item !== userId)
  const pending = current.pending.includes(userId) ? current.pending : [...current.pending, userId]
  return updateAllowlist({ allowed, pending })
}

/**
 * 记录一个陌生人的申请（待审批）。
 *
 * @param userId - 申请者的微信 user id。
 * @returns 写入后的授权状态。
 */
export async function requestAccess(userId) {
  if (typeof userId !== 'string' || userId === '') return loadAllowlist()
  const current = await loadAllowlist()
  if (current.owner === userId || current.allowed.includes(userId)) return current
  if (current.pending.includes(userId)) return current
  return updateAllowlist({ pending: [...current.pending, userId] })
}
