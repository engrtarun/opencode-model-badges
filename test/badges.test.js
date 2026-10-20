import test from 'node:test'
import assert from 'node:assert/strict'
import { countRunningModels, pickBadge, stripBadge } from '../lib.ts'

const now = 100_000
const state = (overrides = {}) => ({
  sessionModels: new Map([['s1', 'openai/gpt']]),
  statusBusy: new Set(),
  statusKnown: new Set(),
  lastActivity: new Map(),
  toolBusy: new Map(),
  now,
  activityTtlMs: 15_000,
  toolMaxMs: 600_000,
  ...overrides,
})

test('strips the legacy suffix forms from the issue examples', () => {
  assert.equal(stripBadge('Foo ?'), 'Foo')
  assert.equal(stripBadge('Foo ?? [3]'), 'Foo')
  assert.equal(stripBadge('Foo ? ?? [2]'), 'Foo')
})

test('strips current badges and accumulated mixed suffixes', () => {
  assert.equal(stripBadge('Foo'), 'Foo')
  assert.equal(stripBadge('Foo \u2705'), 'Foo')
  assert.equal(stripBadge('Foo \u2714\uFE0F [3]'), 'Foo')
  assert.equal(stripBadge('Foo \u2B50'), 'Foo')
  assert.equal(stripBadge('Foo \u2714\uFE0F [3] \u2705 \u2714\uFE0F [4]'), 'Foo')
  assert.equal(stripBadge('Question?'), 'Question?')
})

test('picks the current UI badge for zero, one, and multiple sessions', () => {
  assert.equal(pickBadge(0), '')
  assert.equal(pickBadge(-1), '')
  assert.equal(pickBadge(1), ' \u2705')
  assert.equal(pickBadge(2), ' \u2714\uFE0F [2]')
  assert.equal(pickBadge(3), ' \u2714\uFE0F [3]')
})

test('counts a session once when busy status and fresh activity overlap', () => {
  const counts = countRunningModels(state({
    statusBusy: new Set(['s1']),
    lastActivity: new Map([['s1', now]]),
  }))
  assert.deepEqual([...counts], [['openai/gpt', 1]])
  assert.equal(pickBadge(counts.get('openai/gpt') ?? 0), ' \u2705')
})

test('counts distinct active sessions on the same model', () => {
  const counts = countRunningModels(state({
    sessionModels: new Map([['s1', 'openai/gpt'], ['s2', 'openai/gpt'], ['s3', 'anthropic/claude']]),
    statusBusy: new Set(['s1', 's2']),
    lastActivity: new Map([['s3', now]]),
  }))
  assert.deepEqual([...counts], [['openai/gpt', 2], ['anthropic/claude', 1]])
})

test('ignores stale activity unless a tool call is still open', () => {
  const counts = countRunningModels(state({
    lastActivity: new Map([['s1', now - 20_000]]),
    toolBusy: new Map([['s1', new Map([['tool-1', now - 5_000]])]]),
  }))
  assert.deepEqual([...counts], [['openai/gpt', 1]])
  const expired = countRunningModels(state({
    lastActivity: new Map([['s1', now - 20_000]]),
    toolBusy: new Map([['s1', new Map([['tool-1', now - 700_000]])]]),
  }))
  assert.deepEqual([...expired], [])
})

test('counts a tool-only session and ignores missing model mappings', () => {
  const counts = countRunningModels(state({
    toolBusy: new Map([['s1', new Map([['tool-1', now - 1_000]])], ['missing-model', new Map([['tool-2', now - 1_000]])]]),
  }))
  assert.deepEqual([...counts], [['openai/gpt', 1]])
})
