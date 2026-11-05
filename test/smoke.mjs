/**
 * Smoke test for the Client half, without a browser.
 *
 * Runs `client.js` against a minimal React stub and a fake Client context,
 * then walks the rendered element tree of both slot entries. It catches
 * wiring mistakes (renamed props, missing exports, bad hook order) that the
 * browser would otherwise only report as a crashed slot entry.
 *
 *   node test/smoke.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const clientEntry = pathToFileURL(join(here, '..', 'client.js')).href

// --- minimal React ---------------------------------------------------------

const hooks = {
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial ?? null }),
  useEffect: () => {},
  useCallback: (fn) => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), ...(children.length > 0 ? { children } : {}) },
  }),
}

// --- globals the module touches -------------------------------------------

let definition = null
globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value } } }

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}

// `client.js` is a plugin module rather than an ES module of its own; importing
// it only fills `definition`.
await import(clientEntry)
assert.ok(definition !== null, 'client.js did not register a module definition')
assert.equal(definition.id, '@ixtwuko/dsh-staging-list')

const plugin = definition.factory((id) => {
  assert.equal(id, 'react')
  return hooks
})

// --- fake Client context ---------------------------------------------------

const registered = []
const ctx = {
  effect: (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: { register: () => () => {} },
  slots: {
    inject: (_key, callback) => callback(),
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
  },
  remote: { session: { prompt: async () => ({ ok: true }) } },
}

plugin.apply(ctx)
assert.deepEqual(
  registered.map((entry) => entry.options.id),
  ['staging-stash', 'staging-list'],
)

const component = (id) => registered.find((entry) => entry.options.id === id).component

// --- tree walking ----------------------------------------------------------

function walk(node, visit, depth = 0) {
  if (node === null || node === undefined || node === false) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, depth)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ text: String(node) })
    return
  }
  if (typeof node.type === 'function') {
    assert.ok(depth < 8, 'component nesting is unexpectedly deep')
    walk(node.type(node.props), visit, depth + 1)
    return
  }
  visit({ tag: node.type, props: node.props })
  walk(node.props.children, visit, depth)
}

function textOf(node) {
  const parts = []
  walk(node, (entry) => {
    if (entry.text !== undefined) parts.push(entry.text)
  })
  return parts.join('')
}

function nodesOf(node, predicate) {
  const found = []
  walk(node, (entry) => {
    if (entry.tag !== undefined && predicate(entry)) found.push(entry)
  })
  return found
}

// --- 1. stash button -------------------------------------------------------

// The store caches its document on first read, so the fixture has to be in
// place before any component renders.
storage.set(
  'dsh.staging-list.v1',
  JSON.stringify({ 'sess-b': [{ id: 'i1', text: 'first line\nsecond line' }, { id: 'i2', text: '' }] }),
)

const useInput = (selector) => selector({ draft: 'hello world', phase: 'plain' })
const stash = component('staging-stash')({ sessionId: 'sess-a', useInput, inputActions: { setDraft() {} }, t: undefined })
assert.equal(stash.type, 'button')
assert.match(textOf(stash), /^$/, 'the tray button renders an icon only')
assert.match(stash.props.title, /暂存当前草稿|Stage current draft/)

// --- 2. dock is hidden while the list is empty -----------------------------

const dock = component('staging-list')
const sent = []
const promptApi = () => async (request) => {
  sent.push(request)
  return { ok: true }
}
assert.equal(dock({ sessionId: 'sess-empty', t: undefined, promptApi }), null)

// --- 3. dock renders rows, actions and the trailing add row ----------------

const view = dock({ sessionId: 'sess-b', t: undefined, promptApi })
assert.equal(view.type, 'div')
assert.equal(textOf(view).includes('first line'), true, 'row preview uses the first line')
assert.equal(textOf(view).includes('second line'), false, 'the preview stays on one line')
assert.equal(textOf(view).includes('2 条待发送') || textOf(view).includes('2 unsent'), true)
assert.equal(nodesOf(view, (entry) => entry.props?.className === 'dsl_addRow').length, 1, 'add row is present')

const sendButtons = nodesOf(view, (entry) => entry.props?.className?.includes('dsl_actionSend'))
assert.equal(sendButtons.length, 2, 'every row keeps its send action')
assert.deepEqual(sendButtons.map((entry) => entry.props.disabled), [false, true], 'an empty item cannot be sent')
assert.equal(nodesOf(view, (entry) => entry.props?.className?.includes('dsl_actionDanger')).length, 2)

const list = nodesOf(view, (entry) => entry.tag === 'ul')[0]
const body = list.props.children
assert.equal(body.length, 3, 'two items plus the add row')
assert.equal(typeof body[0].type, 'function', 'rows render through StagingRow')
assert.equal(body[2].props.className, 'dsl_addRow', 'the add row closes the list')
assert.equal(nodesOf(view, (entry) => entry.tag === 'textarea').length, 0, 'editors open on demand only')

// --- 4. sending hands the text to the Session prompt Remote ----------------

sendButtons[0].props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(sent.length, 1, 'one prompt per send')
assert.equal(sent[0].sessionId, 'sess-b')
assert.equal(sent[0].mode, 'queue')
assert.deepEqual(sent[0].content, [{ type: 'text', text: 'first line\nsecond line' }])
assert.equal(typeof sent[0].requestId, 'string')
assert.equal(JSON.parse(storage.get('dsh.staging-list.v1'))['sess-b'].length, 1, 'a sent item leaves the list')

// --- 5. deleting drops only that item --------------------------------------

const deleteButtons = nodesOf(view, (entry) => entry.props?.className?.includes('dsl_actionDanger'))
deleteButtons[1].props.onClick()
assert.equal('sess-b' in JSON.parse(storage.get('dsh.staging-list.v1')), false, 'an emptied list is dropped')

console.log('staging-list: smoke OK')
