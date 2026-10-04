import type { EngineInterface as Engine, Register, Timer } from 'claude-code'

// session-activity:
//   4. side-effects ledger: every action that leaves the machine (MCP writes,
//      pushes, PRs, deploys, posts, emails, SQL writes) is logged with its
//      result and link; /ledger opens it as a pane (this session or all
//      sessions in the last 24h). Writes to a database through execute_sql are
//      held with a question first.
//   5. waiting-on tracker: background commands, subagents, workflows and
//      monitors, plus foreground calls running long, shown beside the spinner
//      and in the band above the prompt with elapsed time.

const PANE = 'ledger'
const LEDGER = 'l:'
const DAY = 24 * 60 * 60_000
const LONG_MS = 15_000 // a foreground call running this long counts as waiting
const STALE_MS = 3 * 60 * 60_000

type Entry = { ts: number; kind: string; detail: string; ok: boolean; link: string | null }
type Ledger = { sessionId: string; task: string; entries: Entry[] }
type Wait = { id: string; label: string; kind: string; since: number; background: boolean }

let sessionId = ''
let ledger: Ledger = { sessionId: '', task: '', entries: [] }
let showAll = false
let timers: Timer[] = []
const waits = new Map<string, Wait>() // keyed by tool_use_id

const HUMAN = new Set(['composer', 'bridge', 'sdk'])
const OUTWARD =
  /^(post|patch|put|create|update|delete|send|publish|apply|upload|trash|merge|fire|schedule|bind|set|reply|forward|share|deploy|log|calibrate|promote|rollback|add|remove|buy|cancel|respond|label|unlabel|mark|archive)_/
const LOCAL_SERVERS =
  /^mcp__(Claude_Browser|computer-use|claude-in-chrome|visualize|ccd_session|ccd_view|ccd_window|ccd_sidebar|ccd_directory|ccd_connectors|terminal|filesystem|puppeteer|config-registry|mcp-registry)/
const SQL_WRITE =
  /\b(insert\s+into|update\s+[\w."]+\s+set|delete\s+from|alter\s+(table|type|function|policy|view)|drop\s+\w|truncate\s|create\s+(or\s+replace\s+)?\w|grant\s|revoke\s|comment\s+on|copy\s+\w)/i

const short = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}
const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60)}m`
}
const hhmm = (ts: number) => new Date(ts).toTimeString().slice(0, 5)
const firstUrl = (text: string) => text.match(/https:\/\/[^\s"'<>)\]]+/)?.[0] ?? null

type Call = { tool: string } & Record<string, unknown>

// What a call does to the outside world, or null when it stays local.
function classify(call: Call): { kind: string; detail: string } | null {
  const t = call.tool
  if (t === 'Bash' && typeof call.command === 'string') {
    const c = call.command
    const rules: Array<[RegExp, string]> = [
      [/\bgit\s+push\b/, 'git push'],
      [/\bgh\s+pr\s+(create|merge|close|comment|review|edit|ready)\b/, 'gh pr'],
      [/\bgh\s+(issue|release)\s+(create|close|comment|edit)\b/, 'gh'],
      [/\bgh\s+api\b.*(-X|--method)\s*(POST|PUT|PATCH|DELETE)/i, 'gh api write'],
      [/\bvercel\b.*(--prod|\bdeploy\b|\balias\b|\benv\s+(add|rm)\b|\bpromote\b|\brollback\b)/, 'vercel'],
      [/\bcurl\b.*(-X\s*(POST|PUT|PATCH|DELETE)|--data|\s-d\s)/i, 'http write'],
      [/\b(npm|bun|pnpm)\s+publish\b/, 'publish'],
      [/\bsupabase\s+(db\s+push|migration\s+up|functions\s+deploy)\b/, 'supabase cli'],
      [/\bfastlane\b|\baltool\b|\bxcrun\s+notarytool\b/, 'app store'],
    ]
    for (const [re, kind] of rules) if (re.test(c)) return { kind, detail: short(c, 90) }
    return null
  }
  if (t === 'Artifact' && (call.action === undefined || call.action === 'publish' || call.action === 'delete'))
    return { kind: `artifact ${String(call.action ?? 'publish')}`, detail: short(String(call.file_path ?? call.url ?? ''), 90) }
  if (!t.startsWith('mcp__') || LOCAL_SERVERS.test(t)) return null

  const server = t.split('__')[1] ?? ''
  let name = t.split('__').pop() ?? t
  let args: Record<string, unknown> = call
  if (name === 'use_tool' && typeof call.name === 'string') {
    name = call.name
    args = (call.args as Record<string, unknown>) ?? {}
  }
  if (name === 'execute_sql') {
    const q = String(call.query ?? '')
    if (!SQL_WRITE.test(stripSql(q))) return null
    return { kind: 'sql write', detail: short(q, 90) }
  }
  if (!OUTWARD.test(name)) return null
  const hint = ['text', 'title', 'subject', 'to', 'name', 'domain', 'id', 'note_id', 'post_id', 'query']
    .map(k => args[k])
    .find(v => typeof v === 'string' && v.length > 0) as string | undefined
  const where = /supabase/.test(server) ? 'supabase ' : /vercel/.test(server) ? 'vercel ' : ''
  return { kind: `${where}${name}`, detail: hint ? short(hint, 80) : '' }
}

// Drop comments and quoted strings so words inside them don't count as SQL.
const stripSql = (q: string) =>
  q.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''").replace(/\$\$[\s\S]*?\$\$/g, ' ')

async function persist($: Engine) {
  if (sessionId) await $.store.set(LEDGER + sessionId, ledger)
}

async function allToday($: Engine): Promise<Array<Entry & { task: string; mine: boolean }>> {
  const now = await $.clock.now()
  const rows: Array<Entry & { task: string; mine: boolean }> = []
  for (const k of await $.store.keys()) {
    if (!k.startsWith(LEDGER)) continue
    const l = (await $.store.get(k)) as Ledger | undefined
    if (!l) continue
    const recent = l.entries.filter(e => now - e.ts < DAY)
    if (recent.length === 0 && l.sessionId !== sessionId) {
      await $.store.delete(k)
      continue
    }
    for (const e of recent) rows.push({ ...e, task: l.task, mine: l.sessionId === sessionId })
  }
  return rows.sort((a, b) => b.ts - a.ts)
}

function waitLabel(call: Call): { label: string; kind: string } {
  if (call.tool === 'Bash') return { label: String(call.description ?? short(String(call.command ?? ''), 40)), kind: 'bg' }
  if (call.tool === 'Agent' || call.tool === 'Task')
    return { label: String(call.description ?? call.subagent_type ?? 'agent'), kind: 'agent' }
  if (call.tool === 'Workflow') return { label: 'workflow', kind: 'workflow' }
  if (call.tool === 'Monitor') return { label: String(call.description ?? 'monitor'), kind: 'monitor' }
  const name = call.tool.split('__').pop() ?? call.tool
  return { label: name, kind: 'call' }
}

async function prune($: Engine) {
  const now = await $.clock.now()
  for (const [k, w] of waits) if (now - w.since > STALE_MS) waits.delete(k)
}

function waitingSummary(now: number) {
  const list = [...waits.values()].filter(w => w.background || now - w.since > LONG_MS)
  return list.sort((a, b) => a.since - b.since)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    ledger = ((await $.store.get(LEDGER + sessionId)) as Ledger | undefined) ?? { sessionId, task: '', entries: [] }
    await $.command.register({ name: 'ledger', description: 'Everything this session sent outside the machine, as a pane' })
    await $.command.register({
      name: 'waiting',
      description: 'What this session is waiting on (background commands, agents, workflows). /waiting clear forgets them.',
      argumentHint: '[clear]',
    })
    for (const t of timers) t.cancel()
    timers = [$.clock.every(5000, () => void (waits.size > 0 ? $.ui.invalidate('ui.render') : undefined))]
    return next(e)
  })

  on('command.run', { command: 'ledger' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Side-effects ledger' })
    return { text: 'Ledger pane opened.' }
  })

  on('command.run', { command: 'waiting' }, async ($, e) => {
    if ((e.args ?? '').trim() === 'clear') {
      waits.clear()
      $.ui.invalidate('ui.render')
      return { text: 'Cleared.' }
    }
    const now = await $.clock.now()
    const list = waitingSummary(now)
    return {
      text: list.length
        ? list.map(w => `${w.kind.padEnd(8)} ${elapsed(now - w.since).padStart(5)}  ${w.label}`).join('\n')
        : 'Not waiting on anything.',
    }
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind
    if ((!kind || HUMAN.has(kind)) && !ledger.task && !e.text.startsWith('<')) {
      ledger.task = short(e.text, 70)
      await persist($)
    }
    // A background task finished: <task-notification> names its tool-use id
    if (kind === 'task-notification' || e.text.includes('<task-notification>')) {
      for (const m of e.text.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>[\s\S]*?<status>([^<]+)<\/status>/g)) {
        if (m[2] !== 'running') waits.delete(m[1]!.trim())
      }
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const call = e as unknown as Call
    const isMain = e.agentId === undefined
    const effect = isMain ? classify(call) : null

    // 4. hold database writes until the user says go
    if (effect?.kind === 'sql write') {
      let answer = 'Stop'
      try {
        answer = await $.ui.ask(`Write to the database with execute_sql? ${short(String(call.query ?? ''), 220)}`, {
          header: 'SQL write',
          options: ['Run it', 'Stop'],
        })
      } catch {
        answer = 'Stop'
      }
      if (answer !== 'Run it') {
        ledger.entries.push({ ts: await $.clock.now(), kind: 'sql write', detail: `STOPPED: ${effect.detail}`, ok: false, link: null })
        await persist($)
        return { deny: 'session-activity: the user stopped this database write. Ask them before writing to the database.' }
      }
    }

    // 5. track what we are waiting on
    const background = call.run_in_background === true || ((call.tool === 'Agent' || call.tool === 'Workflow') && call.run_in_background !== false) || call.tool === 'Monitor'
    if (isMain) {
      const { label, kind } = waitLabel(call)
      waits.set(e.tool_use_id, { id: e.tool_use_id, label: short(label, 50), kind, since: await $.clock.now(), background: false })
    }

    let ran
    try {
      ran = await next(e)
    } finally {
      const w = waits.get(e.tool_use_id)
      if (w) {
        // A background launch stays on the list until its notification arrives
        if (background && !w.background) waits.set(e.tool_use_id, { ...w, background: true })
        else waits.delete(e.tool_use_id)
      }
      void prune($)
    }

    if (effect && !('deny' in ran && ran.deny !== undefined)) {
      ledger.entries.push({
        ts: await $.clock.now(),
        kind: effect.kind,
        detail: effect.detail,
        ok: !ran.isError,
        link: firstUrl(ran.text ?? ''),
      })
      ledger.entries = ledger.entries.slice(-300)
      await persist($)
      $.ui.invalidate('ui.render')
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    // Foreground calls can't outlive a main-loop turn
    if (e.agentId === undefined) for (const [k, w] of waits) if (!w.background) waits.delete(k)
    return next(e)
  })

  // 5. spinner suffix while working
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const now = await $.clock.now()
    const list = waitingSummary(now)
    if (list.length === 0) return next(e)
    const bg = list.filter(w => w.background).length
    const oldest = list[0]!
    const bits = [bg ? `${bg} bg` : '', `${oldest.kind} ${elapsed(now - oldest.since)}`].filter(Boolean)
    return next({ ...e, props: { ...e.props, suffix: ` · ${bits.join(' · ')}…` } })
  })

  // 5. band: background work still running
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const now = await $.clock.now()
    const bg = waitingSummary(now).filter(w => w.background)
    if (bg.length === 0) return below
    const { Box, Text } = $.ui.resolve(e)
    const cols = e.props.bodyColumns ?? 80
    return (
      <Box flexDirection="column">
        <Text>
          <Text color="cyan">⧗ Waiting on </Text>
          <Text>
            {short(bg.map(w => `${w.kind} "${w.label}" ${elapsed(now - w.since)}`).join(' · '), Math.max(30, cols - 14))}
          </Text>
        </Text>
        {below}
      </Box>
    )
  })

  // 4. ledger pane
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const cols = Math.max(30, e.props.bodyColumns ?? 60)
    const rows = showAll
      ? await allToday($)
      : [...ledger.entries].reverse().map(x => ({ ...x, task: ledger.task, mine: true }))
    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={2}>
          <Text dimColor>
            {rows.length} action{rows.length === 1 ? '' : 's'} · {showAll ? 'all sessions, last 24h' : 'this session'}
          </Text>
          <Button
            key="scope"
            label={showAll ? 'This session' : 'All sessions'}
            plain
            onPress={() => {
              showAll = !showAll
              $.ui.invalidate('ui.render')
            }}
          />
        </Box>
        {rows.length === 0 && <Text dimColor>Nothing has left the machine yet.</Text>}
        {rows.slice(0, 80).map((r, i) => (
          <Box key={`${r.ts}-${i}`} flexDirection="column">
            <Text>
              <Text dimColor>{hhmm(r.ts)} </Text>
              <Text color={r.ok ? 'green' : 'red'}>{r.ok ? '✓' : '✗'} </Text>
              <Text bold>{r.kind}</Text>
              {showAll && !r.mine && <Text dimColor> · {short(r.task || 'other session', 30)}</Text>}
            </Text>
            {r.detail && <Text dimColor>  {short(r.detail, cols - 2)}</Text>}
            {r.link && (
              <Box>
                <Text>  </Text>
                <Link href={r.link} label={short(r.link.replace(/^https:\/\//, ''), cols - 4)} />
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
