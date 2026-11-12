/**
 * 共存账号：让本插件知道同一台机器上还有哪些别的微信 ClawBot 账号。
 *
 * ## 为什么需要它
 *
 * 微信 ClawBot 通道是「单账号模式」：一次扫码登录会把**这个微信用户**绑到
 * 新建的 bot 账号上，而同一个微信用户原先绑定的 bot 会失效。于是当 WorkBuddy
 * 已经用某个微信登录过 clawbot，而用户又拿同一个微信来扫本插件的码时，
 * 服务端会把绑定改到新 bot 上，WorkBuddy 那边就变成
 * `errcode -14 session timeout`。
 *
 * 官方通道用一个 `local_token_list` 参数避免这件事：请求二维码时把**本机
 * 已有的 bot token** 一并报上去，服务端据此知道这台机器已经绑过哪些 bot，
 * 扫码时便不会新建并顶掉旧的绑定。
 *
 * 官方实现只报自己那份凭据；两个应用各管各的目录时，彼此看不见对方的 bot，
 * 于是就撞了。本模块让插件可以登记「本机还有哪些别的 clawbot 账号」，把它们
 * 的 token 一并放进 `local_token_list`。
 *
 * ## token 从哪来
 *
 * 只登记**用户自己提供**的 token：插件不会去读别的应用的加密凭据（那些是它们
 * 自己的密钥体系，读不了也不该读）。用户在设置页填入即可。token 只保存在本机，
 * 权限 0600。
 *
 * @module dsh-wechat-assistant/coexist
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { stateDir } from './store.js'

function coexistPath() {
  return join(stateDir(), 'coexist.json')
}

/**
 * 一个共存账号的登记信息。
 *
 * @typedef {object} CoexistAccount
 * @property {string} label      用户给的名字，便于辨认来源应用。
 * @property {string} token      该账号的 bot token（只在请求二维码时报给服务端）。
 * @property {string} [note]     备注。
 */

/**
 * 读取登记的共存账号。
 *
 * @returns `{ accounts: CoexistAccount[] }`。
 */
export async function loadCoexist() {
  try {
    const raw = JSON.parse(await readFile(coexistPath(), 'utf8'))
    const accounts = Array.isArray(raw?.accounts)
      ? raw.accounts.filter(
          (item) =>
            item !== null &&
            typeof item === 'object' &&
            typeof item.label === 'string' &&
            item.label.trim() !== '' &&
            typeof item.token === 'string' &&
            item.token.trim() !== '',
        )
      : []
    return { accounts }
  } catch {
    return { accounts: [] }
  }
}

/**
 * 写回共存账号列表。
 *
 * @param accounts - 完整列表。
 */
async function saveCoexist(accounts) {
  const path = coexistPath()
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify({ accounts }, null, 2), 'utf8')
  try {
    await chmod(temp, 0o600)
  } catch {
    // Windows 上 chmod 基本无效。
  }
  await rename(temp, path)
}

/**
 * 登记一个共存账号（同名覆盖）。
 *
 * @param account - 账号信息。
 * @returns 写入后的完整列表。
 */
export async function addCoexist(account) {
  if (typeof account?.label !== 'string' || account.label.trim() === '') {
    throw new Error('需要一个名字来说明这是哪个应用的账号')
  }
  if (typeof account?.token !== 'string' || account.token.trim() === '') {
    throw new Error('缺少该账号的 bot token')
  }
  const current = await loadCoexist()
  const entry = {
    label: account.label.trim(),
    token: account.token.trim(),
    ...(typeof account.note === 'string' && account.note.trim() !== '' ? { note: account.note.trim() } : {}),
  }
  const accounts = current.accounts.some((a) => a.label === entry.label)
    ? current.accounts.map((a) => (a.label === entry.label ? entry : a))
    : [...current.accounts, entry]
  await saveCoexist(accounts)
  return accounts
}

/**
 * 移除一个共存账号。
 *
 * @param label - 账号名字。
 * @returns 写入后的完整列表。
 */
export async function removeCoexist(label) {
  const current = await loadCoexist()
  const accounts = current.accounts.filter((a) => a.label !== label)
  await saveCoexist(accounts)
  return accounts
}

/**
 * 组装请求二维码时要报给服务端的 token 列表：本插件自己的 token，加上登记的
 * 共存账号的 token。
 *
 * 服务端靠这个列表判断「这台机器已经绑过哪些 bot」，从而在扫码时复用既有绑定，
 * 而不是新建一个并让旧的失效。官方通道最多报 10 个，这里沿用同样的上限。
 *
 * @param ownToken - 本插件自己的 bot token。
 * @param coexist - 登记的共存账号。
 * @returns 去重后的 token 列表。
 */
export function buildLocalTokenList(ownToken, coexist) {
  const tokens = []
  const seen = new Set()
  const push = (value) => {
    if (typeof value !== 'string') return
    const token = value.trim()
    if (token === '' || seen.has(token)) return
    seen.add(token)
    tokens.push(token)
  }
  push(ownToken)
  for (const account of coexist.accounts ?? []) push(account.token)
  return tokens.slice(0, 10)
}
