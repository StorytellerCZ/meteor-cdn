import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

// Run the package's global export in a Meteor-like scope without starting an app.
function loadCdn(env = {}) {
  const handlers = []
  const internals = {
    setBundledJsCssUrlRewriteHook: mock.fn(),
    staticFilesByArch: { 'web.browser': { '/app.js': {} } },
  }
  const scope = vm.createContext({
    URL,
    path,
    console: { debug: mock.fn(), warn: mock.fn(), info: mock.fn() },
    process: { env },
    Meteor: { Error, isModern: true, startup: mock.fn() },
    WebApp: { rawHandlers: { use: (...args) => handlers.push(args) } },
    WebAppInternals: internals,
    Package: {},
    __meteor_bootstrap__: { configJson: {} },
    __meteor_runtime_config__: {},
  })
  const source = readFileSync(new URL('../../lib/server.js', import.meta.url), 'utf8')
  vm.runInContext(source.replace(/^import .*$/gm, ''), scope)
  return { controller: new scope.CDN._controllerClass(), internals, handlers }
}

function response() {
  return { setHeader: mock.fn(), writeHead: mock.fn(), write: mock.fn(), end: mock.fn() }
}

describe('CDN URL handling', () => {
  it('disables CDN routing when no CDN is configured', () => {
    assert.equal(loadCdn({ ROOT_URL: 'https://example.com' }).handlers.length, 0)
  })

  it('validates absolute HTTP(S) URLs and detects the same host', () => {
    const { controller } = loadCdn()
    assert.equal(controller._validateSettings('https://example.com', 'https://cdn.example.com'), true)
    assert.equal(controller._validateSettings('https://EXAMPLE.com', 'https://example.com'), false)
    assert.throws(() => controller._validateSettings('example.com', 'https://cdn.example.com'), /ROOT_URL is not a valid URL/)
    assert.throws(() => controller._validateSettings('https://example.com', 'cdn.example.com'), /CDN_URL is not a valid URL/)
    assert.throws(() => controller._validateSettings('https://example.com', 'ftp://cdn.example.com'), /http or https/)
  })

  it('preserves CSS exclusions and Galaxy cache-busting queries', () => {
    const { controller } = loadCdn({ GALAXY_APP_VERSION_ID: 'v1' })
    assert.equal(controller._processAssetPath('https://cdn.example.com', '/app.css?v=2'), '/app.css?v=2')
    assert.equal(controller._processAssetPath('https://cdn.example.com', '/app.js?v=2'), 'https://cdn.example.com/app.js?v=2&_g_app_v_=v1')
    assert.equal(controller._processAssetPath('https://cdn.example.com', '/app.js'), 'https://cdn.example.com/app.js?_g_app_v_=v1')
  })

  it('adds font CORS headers for relative request URLs with queries', () => {
    const { controller } = loadCdn()
    const res = response()
    const next = mock.fn()
    controller._CORSConnectHandler({ url: '/font.woff2?v=1' }, res, next)
    assert.ok(res.setHeader.mock.calls.some(({ arguments: args }) => args[0] === 'Access-Control-Allow-Origin' && args[1] === '*'))
    assert.equal(next.mock.callCount(), 1)
  })

  it('serves known CDN assets and rejects missing assets without blocking origin routes', () => {
    const { controller } = loadCdn({ ROOT_URL: 'https://example.com', CDN_URL: 'https://cdn.example.com' })
    for (const [host, url, status] of [
      ['cdn.example.com', '/app.js?v=1', undefined],
      ['cdn.example.com', '/missing.js', 404],
      // Meteor doesn't normalise these, so they must not match /app.js
      ['cdn.example.com', '/x/../app.js', 404],
      ['cdn.example.com', '/%2e%2e/app.js', 404],
      ['cdn.example.com', '//cdn.example.com/app.js', 404],
      ['cdn.example.com', 'https://cdn.example.com/app.js?v=1', undefined],
      ['example.com', '/story/a', undefined],
    ]) {
      const res = response()
      const next = mock.fn()
      controller._static404connectHandler({ url, headers: { host } }, res, next)
      if (status) {
        assert.deepEqual(Array.from(res.writeHead.mock.calls[0].arguments), [status])
        assert.equal(next.mock.callCount(), 0)
      } else {
        assert.equal(next.mock.callCount(), 1)
      }
    }
  })

  it('recognises CDN Host headers with an explicit default port', () => {
    const { controller } = loadCdn({ ROOT_URL: 'https://example.com', CDN_URL: 'https://cdn.example.com:443' })
    for (const host of ['cdn.example.com:443', 'cdn.example.com', 'CDN.example.com']) {
      const res = response()
      const next = mock.fn()
      controller._static404connectHandler({ url: '/missing.js', headers: { host } }, res, next)
      assert.deepEqual(Array.from(res.writeHead.mock.calls[0].arguments), [404])
      assert.equal(next.mock.callCount(), 0)
    }
  })

  it('returns 400 for malformed URLs without throwing from request handlers', () => {
    const { controller } = loadCdn({ ROOT_URL: 'https://example.com', CDN_URL: 'https://cdn.example.com' })
    for (const handler of [controller._CORSConnectHandler, controller._static404connectHandler]) {
      const res = response()
      const next = mock.fn()
      handler({ url: 'http://[invalid', headers: { host: 'cdn.example.com' } }, res, next)
      assert.deepEqual(Array.from(res.writeHead.mock.calls[0].arguments), [400])
      assert.deepEqual(Array.from(res.end.mock.calls[0].arguments), ['Bad Request'])
      assert.equal(next.mock.callCount(), 0)
    }
  })
})
