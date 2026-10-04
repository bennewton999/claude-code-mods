import type { EngineInterface as Engine, Register } from 'claude-code'

// context-gauge:
//   9. a status-line gauge of the context window (percent, tokens, compactions
//      so far), toasts as it crosses 70% and 85%, and a band row from 80% with
//      a "Compact now" button. At each compaction it tells the summarizer what
//      was in flight, logs that snapshot, and hands it back to Claude with the
//      next prompt. /context-log lists the compactions of this session.

const LOG = 'c:'
const WARN_AT = 80
const TOAST_AT = [70, 85]

type Compaction = {
  ts: number
  trigger: string
  percent: number | null
  tokensBefore: number | null
  tokensAfter: number | null
  snapshot: string
}

let sessionId = ''
let percent: number | null = null
let tokens: number | null = null
let windowSize: number | null = null
let toasted = new Set<number>()
let compactions: Compaction[] = []
let reinject: string | null = null

// What the session is in the middle of, gathered from its own events
let task = ''
let lastPrompt = ''
const edited: string[] = []
const actions: string[] = []
const links = new Set<string>()

const HUMAN = new Set(['composer', 'bridge', 'sdk'])

const short = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const hhmm = (ts: number) => new Date(ts).toTimeString().slice(0, 5)

function snapshot(): string {
  const lines = [`Task: ${task || '(unknown)'}`]
  if (lastPrompt && lastPrompt !== task) lines.push(`Latest request: ${lastPrompt}`)
  if (edited.length) lines.push(`Files edited: ${edited.slice(-12).join(', ')}`)
  if (links.size) lines.push(`PRs/links in play: ${[...links].slice(-5).join(', ')}`)
  if (actions.length) lines.push(`Last actions: ${actions.slice(-8).join(' | ')}`)
  return lines.join('\n')
}

async function measure($: Engine) {
  try {
    const u = await $.session.usage()
    percent = typeof u.context.percent === 'number' ? Math.round(u.context.percent) : null
    tokens = u.context.tokens ?? null
    windowSize = u.context.window
  } catch {
    return
  }
  const bits: string[] = []
  if (percent !== null) bits.push(`ctx ${percent}%`)
  if (tokens !== null && windowSize) bits.push(`${k(tokens)}/${k(windowSize)}`)
  if (compactions.length) bits.push(`compacted ${compactions.length}×`)
  $.ui.status(bits.length ? bits.join(' · ') : undefined)

  if (percent !== null) {
    for (const t of TOAST_AT) {
      if (percent >= t && !toasted.has(t)) {
        toasted.add(t)
        $.ui.toast(
          t >= 85
            ? `Context at ${percent}%: compaction is close. /compact now keeps the in-flight work in the summary.`
            : `Context at ${percent}%`,
          { timeoutMs: t >= 85 ? 12_000 : 6000 },
        )
      }
    }
  }
  $.ui.invalidate('ui.render')
}

async function persist($: Engine) {
  if (sessionId) await $.store.set(LOG + sessionId, compactions)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    compactions = ((await $.store.get(LOG + sessionId)) as Compaction[] | undefined) ?? []
    // Drop logs of sessions untouched for a week
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (!key.startsWith(LOG) || key === LOG + sessionId) continue
      const list = (await $.store.get(key)) as Compaction[] | undefined
      const last = list?.[list.length - 1]?.ts ?? 0
      if (now - last > 7 * 24 * 60 * 60_000) await $.store.delete(key)
    }
    // A resumed session starts a new process: recover the task from the transcript
    if (!task) {
      try {
        const msgs = await $.session.messages()
        const human = msgs.filter(m => m.role === 'user' && m.text && !m.text.startsWith('<'))
        if (human[0]) task = short(human[0].text, 120)
        const latest = human[human.length - 1]
        if (latest) lastPrompt = short(latest.text, 160)
      } catch {
        // no transcript yet
      }
    }
    await $.command.register({
      name: 'context-log',
      description: 'Context fill now, and what was in flight at each compaction this session',
    })
    void measure($)
    return next(e)
  })

  on('command.run', { command: 'context-log' }, async $ => {
    await measure($)
    const head = `Context: ${percent ?? '?'}%${tokens !== null && windowSize ? ` (${k(tokens)} of ${k(windowSize)})` : ''} · ${compactions.length} compaction${compactions.length === 1 ? '' : 's'} this session`
    const body = compactions.map(
      (c, i) =>
        `#${i + 1} ${hhmm(c.ts)} ${c.trigger}${c.percent !== null ? ` at ${c.percent}%` : ''}${c.tokensBefore && c.tokensAfter ? ` (${k(c.tokensBefore)} → ${k(c.tokensAfter)})` : ''}\n${c.snapshot.replace(/^/gm, '    ')}`,
    )
    return { text: [head, ...body].join('\n\n') }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) void measure($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind
    if ((!kind || HUMAN.has(kind)) && !e.text.startsWith('<')) {
      if (!task) task = short(e.text, 120)
      lastPrompt = short(e.text, 160)
    }
    if (reinject) {
      const text = reinject
      reinject = null
      return next({
        ...e,
        context: [...(e.context ?? []), `[context-gauge] Just before the last compaction, this session was:\n${text}`],
      })
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined) return ran
    const call = e as unknown as { tool: string } & Record<string, unknown>
    const fp = (call.file_path ?? call.notebook_path) as string | undefined
    if (['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(call.tool) && typeof fp === 'string') {
      const name = fp.replace(/^\/Users\/[^/]+/, '~')
      const i = edited.indexOf(name)
      if (i >= 0) edited.splice(i, 1)
      edited.push(name)
      if (edited.length > 30) edited.shift()
    }
    const what =
      call.tool === 'Bash' && typeof call.command === 'string'
        ? `$ ${short(call.command, 60)}`
        : typeof fp === 'string'
          ? `${call.tool} ${fp.split('/').pop()}`
          : call.tool.startsWith('mcp__')
            ? (call.tool.split('__').pop() ?? call.tool)
            : call.tool
    actions.push(`${what}${ran.isError ? ' (failed)' : ''}`)
    if (actions.length > 20) actions.shift()
    for (const m of (ran.text ?? '').matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)) links.add(m[0])
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) void measure($)
    return r
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const snap = snapshot()
    const before = percent
    // Ask the summarizer to keep the in-flight state
    const keep = `Preserve exactly, as its own section: the in-flight work below, plus any open PR numbers, branch and worktree names, pending questions to the user, and decisions not yet acted on.\n${snap}`
    const result = await next({ ...e, instructions: e.instructions ? `${e.instructions}\n\n${keep}` : keep })
    if ('skip' in result && result.skip !== undefined) return result

    const entry: Compaction = {
      ts: await $.clock.now(),
      trigger: e.trigger,
      percent: before,
      tokensBefore: result.tokensBefore ?? null,
      tokensAfter: result.tokensAfter ?? null,
      snapshot: snap,
    }
    compactions.push(entry)
    compactions = compactions.slice(-20)
    await persist($)
    reinject = snap
    toasted = new Set()
    $.ui.log(
      `Compaction #${compactions.length} (${e.trigger}${before !== null ? ` at ${before}%` : ''}). In flight: ${short(task || lastPrompt || 'unknown', 80)}${edited.length ? ` · ${edited.length} files edited` : ''}. /context-log for the full snapshot.`,
    )
    void measure($)
    return result
  })

  // Band row once the window is nearly full
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || percent === null || percent < WARN_AT) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text color={percent >= 90 ? 'red' : 'yellow'}>
            ◔ Context {percent}%{tokens !== null && windowSize ? ` (${k(tokens)}/${k(windowSize)})` : ''}: compaction is near
          </Text>
          <Button
            key="compact-now"
            label="Compact now"
            plain
            onPress={async () => {
              await $.session.compact({
                instructions: `Preserve exactly, as its own section, the in-flight work:\n${snapshot()}`,
              })
            }}
          />
        </Box>
        {below}
      </Box>
    )
  })
}
