/**
 * VS Code extension: the observe-agents-do-things dashboard in the side bar,
 * the panel or an editor tab, plus a status bar item that says when an agent
 * needs you.
 *
 * It uses the observer at `observeAgents.serverUrl` (the CLI or the Docker
 * container) when one answers there. Otherwise it runs one inside VS Code on
 * a free port, never on the configured address, so the CLI or Docker can
 * always start later; it switches back to them as soon as they answer. Windows
 * share the observer VS Code started through a small file in the temp folder.
 */
import * as vscode from 'vscode'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type ObserverClient } from '@oadt/client'
import { Observer } from '@oadt/core'
import { attentionItems, isLive, type AttentionItem, type WorldState } from '@oadt/protocol'
import { ObserverServer } from '@oadt/server'

const CONFIG = 'observeAgents'
/** Attention kinds that count as "needs you" in the status bar and notifications. */
const URGENT = new Set<AttentionItem['kind']>(['waiting', 'errors'])

interface Backend {
  url: string
  token?: string
  client: ObserverClient
  /** True when this is the observer at observeAgents.serverUrl rather than one VS Code runs. */
  configured: boolean
  /** Set when this window started the observer itself. */
  close?: () => Promise<void>
}

/** Where a window that runs an observer tells the others about it. */
const SHARED_FILE = join(tmpdir(), 'oadt-vscode-observer.json')
/** How often to look for the CLI or Docker observer while VS Code runs its own (ms). */
const RECHECK_MS = 10_000

let backend: Backend | undefined
let starting: Promise<Backend> | undefined
let panel: vscode.WebviewPanel | undefined
/** Every webview showing the dashboard (editor tab, side bar, panel), so a restart can point them at the new observer. */
const views = new Set<vscode.Webview>()
let statusItem: vscode.StatusBarItem
let context: vscode.ExtensionContext
const notified = new Set<string>()

export function activate(ctx: vscode.ExtensionContext): void {
  context = ctx
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  statusItem.command = 'observeAgents.open'
  ctx.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('observeAgents.open', openDashboard),
    vscode.commands.registerCommand('observeAgents.showSidebar', () => vscode.commands.executeCommand('observeAgents.sidebar.focus')),
    vscode.commands.registerCommand('observeAgents.showPanel', () => vscode.commands.executeCommand('observeAgents.panel.focus')),
    vscode.window.registerWebviewViewProvider('observeAgents.sidebar', { resolveWebviewView: showInView }, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider('observeAgents.panel', { resolveWebviewView: showInView }, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('observeAgents.openInBrowser', async () => {
      const b = await ensureBackend()
      await vscode.env.openExternal(await externalUri(b))
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG}.serverUrl`) || e.affectsConfiguration(`${CONFIG}.token`)) void restart()
      else if (e.affectsConfiguration(CONFIG)) render()
    }),
  )
  const timer = setInterval(render, 2000)
  const recheckTimer = setInterval(() => void recheck(), RECHECK_MS)
  ctx.subscriptions.push({ dispose: () => { clearInterval(timer); clearInterval(recheckTimer) } })
  if (setting<boolean>('statusBar')) ensureBackend().catch(() => render())
}

export async function deactivate(): Promise<void> {
  await shutdown()
}

function setting<T>(key: string): T {
  return vscode.workspace.getConfiguration(CONFIG).get<T>(key)!
}

// ─── Finding or starting the observer ─────────────────────────────────────

function ensureBackend(): Promise<Backend> {
  if (backend) return Promise.resolve(backend)
  starting ??= start().finally(() => { starting = undefined })
  return starting
}

async function start(): Promise<Backend> {
  const configuredUrl = setting<string>('serverUrl').replace(/\/+$/, '')
  const token = setting<string>('token') || undefined
  let url = configuredUrl
  let configured = true
  let close: (() => Promise<void>) | undefined
  if (!(await isObserver(url, token))) {
    const target = new URL(configuredUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
      throw new Error(`No observer answers at ${configuredUrl}. Start one there, or point observeAgents.serverUrl at 127.0.0.1 to run it inside VS Code.`)
    }
    configured = false
    const shared = readShared()
    if (shared && (await isObserver(shared))) {
      url = shared
    } else {
      const embedded = await startEmbedded()
      url = embedded.url
      close = embedded.close
    }
  }
  const client = connect({ url, token: configured ? token : undefined })
  client.onChange(() => render())
  client.on('status', (s) => {
    render()
    // If the observer went away (Docker restarting, or the window that ran it closed), find or start another.
    if (s === 'reconnecting' && !close) setTimeout(() => { if (backend?.client === client && client.status !== 'live') void restart() }, 3000)
  })
  client.connect()
  backend = { url, token, client, configured, close }
  render()
  return backend
}

/** While VS Code runs its own observer, switch to the CLI or Docker one as soon as it answers. */
async function recheck(): Promise<void> {
  const b = backend
  if (!b || b.configured || starting) return
  const configuredUrl = setting<string>('serverUrl').replace(/\/+$/, '')
  if (await isObserver(configuredUrl, setting<string>('token') || undefined)) await restart()
}

function readShared(): string | undefined {
  try {
    const { url } = JSON.parse(readFileSync(SHARED_FILE, 'utf8')) as { url?: string }
    return typeof url === 'string' ? url : undefined
  } catch {
    return undefined
  }
}

async function isObserver(url: string, token?: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/info`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(800),
    })
    const info = (await res.json()) as { protocol?: number }
    return res.ok && info.protocol === 1
  } catch {
    return false
  }
}

/** An observer inside VS Code on a free port, announced to the other windows. */
async function startEmbedded(): Promise<{ url: string; close: () => Promise<void> }> {
  const observer = new Observer({ sinceMs: 6 * 3_600_000 })
  await observer.start()
  const uiDir = vscode.Uri.joinPath(context.extensionUri, 'ui').fsPath
  const server = new ObserverServer({ observer, host: '127.0.0.1', port: 0, uiDir })
  let url: string
  try {
    url = (await server.listen()).url
  } catch (err) {
    observer.stop()
    throw err
  }
  try { writeFileSync(SHARED_FILE, JSON.stringify({ url, pid: process.pid })) } catch { /* other windows will start their own */ }
  return {
    url,
    close: async () => {
      if (readShared() === url) rmSync(SHARED_FILE, { force: true })
      observer.stop()
      await server.close()
    },
  }
}

async function shutdown(): Promise<void> {
  const b = backend
  backend = undefined
  b?.client.close()
  await b?.close?.()
}

async function restart(): Promise<void> {
  await shutdown()
  notified.clear()
  try {
    await ensureBackend()
    const html = await dashboardHtml(backend!)
    for (const view of views) view.html = html
  } catch {
    render()
  }
}

async function externalUri(b: Backend): Promise<vscode.Uri> {
  const uri = await vscode.env.asExternalUri(vscode.Uri.parse(b.url))
  return b.token ? uri.with({ query: `token=${encodeURIComponent(b.token)}` }) : uri
}

// ─── Dashboard tab ────────────────────────────────────────────────────────

async function openDashboard(): Promise<void> {
  if (panel) return panel.reveal()
  let b: Backend
  try {
    b = await ensureBackend()
  } catch (err) {
    void vscode.window.showErrorMessage(`Observe Agents: ${(err as Error).message}`)
    return
  }
  panel = vscode.window.createWebviewPanel('observeAgents', 'Agents', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  })
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png')
  const webview = panel.webview
  views.add(webview)
  panel.onDidDispose(() => { panel = undefined; views.delete(webview) })
  webview.html = await dashboardHtml(b)
}

/** The same dashboard in the side bar or the panel. */
async function showInView(view: vscode.WebviewView): Promise<void> {
  view.webview.options = { enableScripts: true }
  views.add(view.webview)
  view.onDidDispose(() => views.delete(view.webview))
  try {
    view.webview.html = await dashboardHtml(await ensureBackend())
  } catch (err) {
    view.webview.html = `<p style="padding: 8px 12px">${escapeHtml((err as Error).message)}</p>`
  }
}

/** The webview only frames the observer's own page, so the dashboard is the same one the browser shows. */
async function dashboardHtml(b: Backend): Promise<string> {
  const src = (await externalUri(b)).toString(true)
  const origin = new URL(src).origin
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'">
<style>html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: transparent; } iframe { border: 0; width: 100%; height: 100%; display: block; }</style>
</head><body><iframe src="${src.replace(/"/g, '&quot;')}" title="Agents" allow="clipboard-write"></iframe></body></html>`
}

// ─── Status bar and notifications ─────────────────────────────────────────

function render(): void {
  if (!setting<boolean>('statusBar')) return void statusItem.hide()
  const client = backend?.client
  if (!client || client.status !== 'live') {
    statusItem.text = '$(eye-closed) Agents'
    statusItem.tooltip = client ? 'Observe Agents: reconnecting…' : 'Observe Agents: not running. Click to start.'
    statusItem.backgroundColor = undefined
    statusItem.show()
    return
  }
  const world = client.world
  const items = attentionItems(world, Date.now())
  const urgent = items.filter((i) => URGENT.has(i.kind))
  const working = workingAgents(world)
  if (urgent.length) {
    statusItem.text = `$(bell-dot) ${urgent.length} need${urgent.length === 1 ? 's' : ''} you`
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
  } else {
    statusItem.text = working ? `$(pulse) ${working} working` : '$(eye) Agents'
    statusItem.backgroundColor = undefined
  }
  statusItem.tooltip = tooltip(world, items)
  statusItem.show()
  if (setting<boolean>('notifications')) notify(urgent, world)
}

function workingAgents(world: WorldState): number {
  let n = 0
  for (const s of Object.values(world.sessions)) {
    if (!isLive(s)) continue
    for (const a of Object.values(s.agents)) if (a.status === 'working') n++
  }
  return n
}

function sessionTitle(world: WorldState, id: string): string {
  const s = world.sessions[id]
  return s?.meta.title ?? s?.meta.project ?? id.slice(0, 8)
}

function tooltip(world: WorldState, items: AttentionItem[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true)
  md.appendMarkdown('**Observe Agents**\n\n')
  if (items.length) for (const i of items.slice(0, 8)) md.appendMarkdown(`- ${URGENT.has(i.kind) ? '$(bell-dot) ' : ''}${escape(i.title)}: ${escape(sessionTitle(world, i.sessionId))}\n`)
  else md.appendMarkdown('Nothing needs you.\n')
  const live = Object.values(world.sessions).filter(isLive)
  md.appendMarkdown(`\n${live.length} live session${live.length === 1 ? '' : 's'}. Click to open the dashboard.`)
  return md
}

function notify(urgent: AttentionItem[], world: WorldState): void {
  for (const i of urgent) {
    if (notified.has(i.id)) continue
    notified.add(i.id)
    const s = world.sessions[i.sessionId]
    const who = s?.harness === 'codex' ? 'Codex' : 'Claude Code'
    void vscode.window.showWarningMessage(`${who}: ${i.title} (${sessionTitle(world, i.sessionId)})`, 'Open dashboard').then((pick) => {
      if (pick) void openDashboard()
    })
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&')
}
