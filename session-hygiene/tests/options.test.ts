import { test, expect, mock } from 'claude-code/testing'

// Each test answers the tool call itself (beneath the plugin), so nothing runs.
const edit = { tool: 'Edit', file_path: '/repo/src/theme.css', old_string: 'a', new_string: 'font-family: Comic Sans' } as const

test('a banned string trips only when the user configured it', { options: { bannedStrings: ['comic sans'] } }, async ($, on) => {
  mock.clock(on, { now: 1_760_000_000_000 })
  on('tool.call', async () => ({ result: { text: 'ok' } }))
  const r = (await $.tool.call(edit as never)) as { context?: string[] }
  expect(JSON.stringify(r)).toContain('comic sans')
})

test('no banned strings by default', async ($, on) => {
  mock.clock(on, { now: 1_760_000_000_000 })
  on('tool.call', async () => ({ result: { text: 'ok' } }))
  const r = await $.tool.call(edit as never)
  expect(JSON.stringify(r)).not.toContain('tripwire')
})

test('review-before-push is off by default', async ($, on) => {
  mock.clock(on, { now: 1_760_000_000_000 })
  on('tool.call', async () => ({ result: { text: 'ok' } }))
  await $.tool.call(edit as never)
  const r = await $.tool.call({ tool: 'Bash', command: 'git -C /repo push' } as never)
  expect(JSON.stringify(r)).not.toContain('code-review')
})

test('review-before-push trips when turned on', { options: { reviewBeforePush: true } }, async ($, on) => {
  mock.clock(on, { now: 1_760_000_000_000 })
  on('tool.call', async () => ({ result: { text: 'ok' } }))
  await $.tool.call(edit as never)
  const r = await $.tool.call({ tool: 'Bash', command: 'git -C /repo push' } as never)
  expect(JSON.stringify(r)).toContain('code-review')
})

test('env sourcing passes without a question when the hold is off', { options: { holdEnvSourcing: false } }, async ($, on) => {
  mock.clock(on, { now: 1_760_000_000_000 })
  on('tool.call', async () => ({ result: { text: 'ran' } }))
  const r = await $.tool.call({ tool: 'Bash', command: 'source .env && node x.js' } as never)
  expect(JSON.stringify(r)).toContain('ran')
})
