/**
 * Agent 注册表：一个微信可以驱动多个 Agent，每个 Agent 有自己的 preset 和模型。
 *
 * 一个「Agent」在这里是 (名字 → preset + 模型) 的组合。用户可以在设置页建
 * 若干个 Agent，在微信里用 `/use <名字>` 切换；每个 Agent 各自持有自己的
 * DSH Session，互不干扰上下文。
 *
 * @module dsh-wechat-assistant/agents
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { stateDir } from './store.js'

function registryPath() {
  return join(stateDir(), 'agents.json')
}

/**
 * 一个 Agent 的定义。
 *
 * @typedef {object} AgentProfile
 * @property {string} name        唯一名字，微信里用它引用。
 * @property {string} preset      DSH agent preset id；空串表示用默认 preset。
 * @property {string} provider    模型 provider；空串表示用默认 provider。
 * @property {string} model       模型 id；空串表示用默认模型。
 * @property {string} [cwd]       该 Agent 的工作目录；留空则用宿主默认目录。
 * @property {string} [description] 备注，设置页里显示。
 */

/**
 * 默认 Agent：用宿主默认 preset + 默认模型。
 *
 * @returns {AgentProfile}。
 */
export function defaultAgent() {
  return { name: 'default', preset: '', provider: '', model: '', description: '默认 Agent：使用宿主的默认 preset 与默认模型。' }
}

/**
 * 读注册表。
 *
 * @returns `{ agents, defaultName }`。
 */
export async function loadAgents() {
  try {
    const raw = JSON.parse(await readFile(registryPath(), 'utf8'))
    const agents = Array.isArray(raw?.agents) ? raw.agents.filter(isProfile) : []
    if (agents.length === 0) agents.push(defaultAgent())
    const defaultName = typeof raw?.defaultName === 'string' ? raw.defaultName : agents[0].name
    return { agents, defaultName: agents.some((a) => a.name === defaultName) ? defaultName : agents[0].name }
  } catch {
    const agents = [defaultAgent()]
    return { agents, defaultName: agents[0].name }
  }
}

/**
 * 写注册表。
 *
 * @param value - 完整注册表。
 */
async function saveAgents(value) {
  const path = registryPath()
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
  await rename(temp, path)
}

/**
 * 一个对象是否是合法的 Agent 定义。
 *
 * @param value - 待检查的值。
 * @returns 是否合法。
 */
function isProfile(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.name === 'string' &&
    value.name.trim() !== ''
  )
}

/**
 * 合并写入注册表。
 *
 * @param patch - 要覆盖的字段。
 * @returns 写入后的注册表。
 */
export async function updateAgents(patch) {
  const current = await loadAgents()
  const next = { ...current, ...patch }
  await saveAgents(next)
  return next
}

/**
 * 新增或更新一个 Agent。
 *
 * @param profile - Agent 定义；带 `name` 的同名项会被覆盖。
 * @returns 写入后的注册表。
 */
export async function upsertAgent(profile) {
  if (!isProfile(profile)) throw new Error('Agent 定义需要一个非空的名字')
  const current = await loadAgents()
  // `default` 是保留名：它代表「用宿主的默认 preset 与模型」，不能被改写
  // 成别的名字，也不能被顶掉。
  if (profile.name === 'default' && !current.agents.some((a) => a.name === 'default')) {
    throw new Error('default 是保留名，请换一个名字')
  }
  const agents = current.agents.some((a) => a.name === profile.name)
    ? current.agents.map((a) => (a.name === profile.name ? { ...a, ...profile } : a))
    : [...current.agents, { ...defaultAgent(), ...profile }]
  return updateAgents({ agents })
}

/**
 * 删除一个 Agent。`default` 不可删——它是宿主默认模型/preset 的占位，
 * 删掉会让「用宿主默认」这个选项无处安放。
 *
 * @param name - Agent 名字。
 * @returns 写入后的注册表。
 */
export async function removeAgent(name) {
  if (name === 'default') throw new Error('default Agent 不能删除')
  const current = await loadAgents()
  const agents = current.agents.filter((a) => a.name !== name)
  if (agents.length === 0) agents.push(defaultAgent())
  const defaultName = current.defaultName === name ? agents[0].name : current.defaultName
  return updateAgents({ agents, defaultName })
}

/**
 * 设置默认 Agent。
 *
 * @param name - Agent 名字。
 * @returns 写入后的注册表。
 */
export async function setDefaultAgent(name) {
  const current = await loadAgents()
  if (!current.agents.some((a) => a.name === name)) throw new Error(`没有名为 ${name} 的 Agent`)
  return updateAgents({ defaultName: name })
}

/**
 * 按名字取一个 Agent 定义。
 *
 * @param registry - 注册表。
 * @param name - Agent 名字；空串或未知返回默认 Agent。
 * @returns {AgentProfile}。
 */
export function agentNamed(registry, name) {
  const wanted = typeof name === 'string' ? name.trim() : ''
  if (wanted === '') return registry.agents.find((a) => a.name === registry.defaultName) ?? registry.agents[0]
  return registry.agents.find((a) => a.name === wanted) ?? registry.agents.find((a) => a.name === registry.defaultName) ?? registry.agents[0]
}

/**
 * 校验一个模型是否在 DSH 的模型目录里。
 *
 * @param ctx - 插件上下文，需要 `llm` 服务。
 * @param provider - provider id。
 * @param model - 模型 id。
 * @returns `{ ok, reason, models }`：models 是该 provider 下的模型列表。
 */
export async function checkModel(ctx, provider, model) {
  const llm = ctx.get('llm')
  if (llm === undefined) return { ok: false, reason: '当前部署没有模型目录服务', models: [] }
  if (provider === '' || model === '') return { ok: true, reason: '', models: [] }
  try {
    const models = await llm.listModels(provider)
    const ids = models.map((m) => m.id)
    if (!ids.includes(model)) {
      return { ok: false, reason: `provider ${provider} 下没有模型 ${model}`, models }
    }
    return { ok: true, reason: '', models }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error), models: [] }
  }
}

/**
 * 列出 DSH 当前可用的 provider 与模型。
 *
 * @param ctx - 插件上下文，需要 `llm` 服务。
 * @returns `{ providers: [{ id, name, models: [{ id, name }] }] }`。
 */
export async function listCatalog(ctx) {
  const llm = ctx.get('llm')
  if (llm === undefined) return { providers: [] }
  const providers = []
  for (const provider of llm.listProviders()) {
    let models = []
    try {
      models = (await llm.listModels(provider.id)).map((m) => ({ id: m.id, name: m.name }))
    } catch {
      models = []
    }
    providers.push({ id: provider.id, name: provider.name, models })
  }
  return { providers }
}
