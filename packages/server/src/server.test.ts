import assert from 'node:assert/strict'
import { request } from 'node:http'
import { test } from 'node:test'
import { ObserverClient } from '@oadt/client'
import { Observer } from '@oadt/core'
import { ObserverServer } from './server.js'

async function boot(opts: { token?: string } = {}) {
  const observer = new Observer({ harnesses: [] })
  await observer.start()
  const server = new ObserverServer({ observer, port: 0, ...opts })
  const { url } = await server.listen()
  return { observer, server, url, close: async () => { observer.stop(); await server.close() } }
}

function raw(url: string, path: string, headers: Record<string, string> = {}, method = 'GET', body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url + path, { method, headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

const until = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('client mirrors the server world over SSE and resumes after reconnect', async () => {
  const { observer, url, close } = await boot()
  try {
    observer.ingest({ harness: 'test', sessionId: 's', agentId: 's', ts: 1, kind: 'session.started', meta: { project: 'demo' } })
    const client = new ObserverClient({ url })
    const seen: string[] = []
    client.on('event', (e) => seen.push(e.kind))
    client.connect()
    await until(() => client.status === 'live')
    assert.equal(client.world.sessions.s?.meta.project, 'demo', 'snapshot delivered')

    observer.ingest([
      { harness: 'test', sessionId: 's', agentId: 's', ts: 2, kind: 'tool.started', callId: 'c', tool: 'Read', category: 'read', title: 'Read x' },
      { harness: 'test', sessionId: 's', agentId: 's', ts: 3, kind: 'tool.finished', callId: 'c', ok: true },
    ])
    await until(() => client.world.seq === observer.store.lastSeq)
    assert.deepEqual(seen, ['tool.started', 'tool.finished'])
    assert.equal(client.world.sessions.s?.counts.tools, 1)
    assert.deepEqual(client.world.sessions.s?.tools, observer.world.sessions.s?.tools)

    const events = await client.sessionEvents('s')
    assert.equal(events.length, 3)
    client.close()
  } finally {
    await close()
  }
})

test('stream resumes from Last-Event-ID without a snapshot', async () => {
  const { observer, url, close } = await boot()
  try {
    for (let i = 0; i < 5; i++) observer.ingest({ harness: 'test', sessionId: 's', agentId: 's', ts: i, kind: 'thinking' })
    const res = await new Promise<string>((resolve) => {
      const req = request(url + '/api/stream', { headers: { 'last-event-id': '3' } }, (r) => {
        let data = ''
        r.on('data', (c) => {
          data += c
          if (data.includes('id: 5')) { req.destroy(); resolve(data) }
        })
      })
      req.end()
    })
    assert.ok(res.includes('event: resumed'))
    assert.ok(!res.includes('event: snapshot'))
    assert.ok(res.includes('id: 4') && res.includes('id: 5') && !res.includes('id: 3\n'))
  } finally {
    await close()
  }
})

test('rejects DNS-rebinding hosts and foreign origins; allows same origin', async () => {
  const { url, close } = await boot()
  try {
    assert.equal((await raw(url, '/api/info', { host: 'evil.example' })).status, 421)
    assert.equal((await raw(url, '/api/info', { origin: 'https://evil.example' })).status, 403)
    const host = new URL(url).host
    assert.equal((await raw(url, '/api/info', { origin: `http://${host}` })).status, 200)
  } finally {
    await close()
  }
})

test('token protects the API', async () => {
  const { url, close } = await boot({ token: 's3cret' })
  try {
    assert.equal((await raw(url, '/api/state')).status, 401)
    assert.equal((await raw(url, '/api/state', { authorization: 'Bearer s3cret' })).status, 200)
    assert.equal((await raw(url, '/api/state?token=s3cret')).status, 200)
  } finally {
    await close()
  }
})

test('ingest validates drafts and requires JSON', async () => {
  const { observer, url, close } = await boot()
  try {
    const post = (body: unknown, type = 'application/json') => raw(url, '/api/ingest', { 'content-type': type }, 'POST', JSON.stringify(body))
    assert.equal((await post({ kind: 'message', sessionId: 'x', role: 'user', text: 'hi' }, 'text/plain')).status, 415)
    assert.equal((await post({ kind: 'nope', sessionId: 'x' })).status, 400)
    assert.equal((await post({ kind: 'tool.started', sessionId: 'x' })).status, 400)
    const ok = await post([{ kind: 'message', sessionId: 'x', role: 'assistant', text: 'hello' }])
    assert.equal(ok.status, 202)
    assert.equal(observer.world.sessions.x?.harness, 'custom')
    assert.equal(observer.world.sessions.x?.lastMessage?.text, 'hello')
  } finally {
    await close()
  }
})
