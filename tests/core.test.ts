import { describe, it, expect } from 'vitest'
import { Bus } from '../src/core/bus'
import { Settings, type KV } from '../src/core/settings'
import { addMessages, setLang, t } from '../src/core/i18n'

function fakeKV(): KV {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  }
}

describe('Bus', () => {
  it('delivers to subscribers and unsubscribes', () => {
    const bus = new Bus()
    const got: number[] = []
    const off = bus.on('view:pick', ({ hz }) => got.push(hz))
    bus.emit('view:pick', { hz: 1 })
    off()
    bus.emit('view:pick', { hz: 2 })
    expect(got).toEqual([1])
  })
})

describe('Settings', () => {
  const def = { key: 'x.n', label: 'x', type: 'number' as const, default: 5, min: 0, max: 10 }

  it('returns defaults, persists, clamps and notifies', () => {
    const kv = fakeKV()
    const s = new Settings(kv)
    s.register([def])
    expect(s.get('x.n')).toBe(5)
    const seen: unknown[] = []
    s.watch('x.n', (v) => seen.push(v))
    s.set('x.n', 99)
    expect(s.get('x.n')).toBe(10)
    expect(seen).toEqual([10])
    expect(new Settings(kv).exportAll()).toEqual({ 'x.n': 10 })
  })

  it('resets only its own keys', () => {
    const kv = fakeKV()
    kv.setItem('other', 'keep')
    const s = new Settings(kv)
    s.register([def])
    s.set('x.n', 7)
    s.set('x.n2', 1)
    s.resetAll()
    expect(s.get('x.n')).toBe(5)
    expect(s.exportAll()).toEqual({})
    expect(kv.getItem('other')).toBe('keep')
  })

  it('ignores stored values of the wrong type', () => {
    const kv = fakeKV()
    kv.setItem('awt:x.n', '"oops"')
    const s = new Settings(kv)
    s.register([def])
    expect(s.get('x.n')).toBe(5)
  })
})

describe('i18n', () => {
  it('falls back to en, then to the key', () => {
    addMessages({ en: { a: 'A {n}', b: 'B' }, es: { a: 'A es {n}' } })
    setLang('es')
    expect(t('a', { n: 1 })).toBe('A es 1')
    expect(t('b')).toBe('B')
    expect(t('zzz')).toBe('zzz')
    setLang('en')
  })
})
