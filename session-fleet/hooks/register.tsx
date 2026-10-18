import type { EngineInterface as Engine, Register, Timer } from 'claude-code'

// session-fleet: one registry of live sessions in $.store (shared by every
// session on the machine), read three ways:
//   1. a pane listing every live session, opened at every session start.
//      Click anywhere on another desktop session's card to switch to it; click
//      a session's name to rename it (kept in the store, shared). Pills tag
//      the project. The band's toggle or /fleet shows and hides it
//   2. the band above the prompt flags other sessions that are waiting on you,
//      and always carries the board's show/hide toggle
//   3. edits and mutating git in a worktree another live session claimed first
//      are held with a question naming that session

const PANE = 'fleet'
const PREFIX = 's:'
const NAME = 'name:' // a rename from the board, by session id; outside PREFIX
const LEGACY_AUTO_OPEN = 'pref:autoOpen'
const ALIVE_MS = 3 * 60_000 // no heartbeat for this long = session is gone
const CLAIM_MS = 30 * 60_000 // a worktree untouched for this long is released
const PRUNE_MS = 24 * 60 * 60_000
const BEAT_MS = 30_000
const REDRAW_MS = 5_000

type Phase = 'working' | 'idle' | 'waiting'

type Claim = { since: number; lastTouch: number }

type Rec = {
  id: string
  task: string
  cwd: string
  branch: string | null
  pr: string | null
  phase: Phase
  waitingWhy: string | null
  waitingSince: number | null
  last: string
  lastAt: number
  beat: number
  claims: Record<string, Claim>
  hostId?: string | null // desktop app session id (local_…), null in a terminal
}

const GIT_MUTATION =
  /\bgit\b(?:\s+-C\s+\S+)?\s+(commit|checkout|switch|reset|rebase|merge|pull|push|stash|add|rm|mv|restore|cherry-pick|revert|am|apply|clean|worktree\s+remove)\b/
const HUMAN = new Set(['composer', 'bridge', 'sdk'])

const me: Rec = {
  id: '',
  task: '',
  cwd: '',
  branch: null,
  pr: null,
  phase: 'idle',
  waitingWhy: null,
  waitingSince: null,
  last: 'started',
  lastAt: 0,
  beat: 0,
  claims: {},
  hostId: null,
}

let lastWrite = 0
let lastRepoRefresh = 0
let timers: Timer[] = []
let editing: string | null = null // the session id whose name is being edited
const toplevelCache = new Map<string, string | null>()
const allowed = new Set<string>() // worktrees the user said to proceed in
const toasted = new Map<string, number>() // other session id -> waitingSince toasted

const short = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

const home = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')

const shortTree = (p: string) => {
  const wt = p.match(/\.claude\/worktrees\/([^/]+)$/)
  if (wt) return `${(p.split('/.claude/')[0] ?? '').split('/').pop()}:${wt[1]}`
  return home(p)
}

// Which project a session works in, from its newest worktree or its cwd
const repoName = (p: string) => (p.split('/.claude/worktrees/')[0] ?? p).split('/').filter(Boolean).pop() ?? ''

type Pill = { label: string; fg: string; bg: string }
type PillRule = { label: string; test: RegExp; bg: string }

const OTHER_BG = '#4b5563'
let pillRules: PillRule[] = []

// The projectPills option: `Label:regex:color` entries separated by `;`
function parseRules(spec: string): PillRule[] {
  const rules: PillRule[] = []
  for (const entry of spec.split(';')) {
    const [label, pattern, color] = entry.split(':').map(x => x.trim())
    if (!label || !pattern) continue
    try {
      rules.push({ label, test: new RegExp(pattern, 'i'), bg: color || OTHER_BG })
    } catch {
      // a bad regex skips its entry
    }
  }
  return rules
}

function pill(r: Rec, now: number): Pill | null {
  const trees = Object.entries(r.claims)
    .filter(([, c]) => now - c.lastTouch < CLAIM_MS)
    .sort((a, b) => b[1].lastTouch - a[1].lastTouch)
  const dir = trees[0]?.[0] ?? r.cwd
  const name = repoName(dir)
  if (!name || /^\/Users\/[^/]+\/?$/.test(dir)) return null // home dir: no project
  const rule = pillRules.find(p => p.test.test(name))
  return { label: rule?.label ?? name, fg: 'white', bg: rule?.bg ?? OTHER_BG }
}

const ago = (now: number, t: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

// The needs-you badge: black on solid yellow, readable in light and dark
const NEEDS_FG = '#000000'
const NEEDS_BG = '#facc15'

// A failed lookup reads as closed, so the needs-you band still draws
const isPaneOpen = async ($: Engine) => {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE)
  } catch {
    return false
  }
}

async function openBoard($: Engine) {
  const r = await $.ui.open({ id: PANE, title: 'Session fleet' })
  $.ui.invalidate('ui.render')
  return r
}

async function closeBoard($: Engine) {
  await $.ui.close({ id: PANE })
  $.ui.invalidate('ui.render')
}

async function toggleBoard($: Engine) {
  if (await isPaneOpen($)) await closeBoard($)
  else await openBoard($)
}

const nameOf = async ($: Engine, r: Rec) =>
  ((await $.store.get(NAME + r.id)) as string | undefined) || r.task || '(no prompt yet)'

async function rename($: Engine, id: string, value: string) {
  const v = value.replace(/\s+/g, ' ').trim()
  if (v) await $.store.set(NAME + id, v.slice(0, 80))
  else await $.store.delete(NAME + id) // empty: back to the first prompt
  editing = null
  $.ui.invalidate('ui.render')
}

async function save($: Engine, force = false) {
  const now = await $.clock.now()
  if (!force && now - lastWrite < 2000) return
  lastWrite = now
  me.beat = now
  if (!me.id) return
  await $.store.set(PREFIX + me.id, me)
}

async function all($: Engine): Promise<Rec[]> {
  const keys = (await $.store.keys()).filter((k: string) => k.startsWith(PREFIX))
  const recs: Rec[] = []
  const now = await $.clock.now()
  for (const k of keys) {
    const r = (await $.store.get(k)) as Rec | undefined
    if (!r) continue
    if (now - r.beat > PRUNE_MS) {
      await $.store.delete(k)
      await $.store.delete(NAME + r.id)
      continue
    }
    recs.push(r)
  }
  return recs
}

const isAlive = (r: Rec, now: number) => now - r.beat < ALIVE_MS

async function toplevel($: Engine, dir: string): Promise<string | null> {
  let d = dir
  for (let i = 0; i < 6 && d && d !== '/'; i++) {
    if (toplevelCache.has(d)) return toplevelCache.get(d) ?? null
    try {
      if (await $.fs.exists(d)) {
        const r = await $.process.run(['git', '-C', d, 'rev-parse', '--show-toplevel'], {
          timeoutMs: 5000,
        })
        const top = r.exitCode === 0 ? r.stdout.trim() : null
        toplevelCache.set(d, top)
        return top
      }
    } catch {
      return null
    }
    d = d.slice(0, d.lastIndexOf('/')) || '/'
  }
  return null
}

const dirname = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'

// Which worktree a tool call writes to, or null when it is not a guarded write.
async function target($: Engine, e: { tool: string } & Record<string, unknown>): Promise<string | null> {
  const fp = (e.file_path ?? e.notebook_path) as string | undefined
  if (['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(e.tool) && typeof fp === 'string') {
    return toplevel($, dirname(fp))
  }
  if (e.tool === 'Bash' && typeof e.command === 'string' && GIT_MUTATION.test(e.command)) {
    const cmd = e.command
    const dashC = cmd.match(/git\s+-C\s+("[^"]+"|'[^']+'|\S+)/)
    const cd = cmd.match(/(?:^|&&|;)\s*cd\s+("[^"]+"|'[^']+'|\S+)/)
    const raw = (dashC?.[1] ?? cd?.[1])?.replace(/^["']|["']$/g, '')
    const base = me.cwd || (await $.session.cwd())
    const homeDir = base.match(/^\/Users\/[^/]+/)?.[0] ?? '/Users'
    const abs = raw?.startsWith('~') ? homeDir + raw.slice(1) : raw
    const dir = abs ? (abs.startsWith('/') ? abs : `${base}/${abs}`) : base
    return toplevel($, dir)
  }
  return null
}

function describe(e: { tool: string } & Record<string, unknown>): string {
  if (e.tool === 'Bash' && typeof e.command === 'string') return `$ ${short(e.command, 48)}`
  const fp = (e.file_path ?? e.notebook_path) as string | undefined
  if (typeof fp === 'string') return `${e.tool} ${fp.split('/').pop()}`
  if (e.tool.startsWith('mcp__')) return e.tool.split('__').pop() ?? e.tool
  return e.tool
}

async function refreshRepo($: Engine) {
  const now = await $.clock.now()
  if (now - lastRepoRefresh < 120_000) return
  lastRepoRefresh = now
  // The worktree touched most recently, else the session's own directory
  const trees = Object.entries(me.claims).sort((a, b) => b[1].lastTouch - a[1].lastTouch)
  const dir = trees[0]?.[0] ?? (await toplevel($, me.cwd))
  if (!dir) {
    me.branch = null
    me.pr = null
    return
  }
  try {
    const b = await $.process.run(['git', '-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeoutMs: 5000,
    })
    me.branch = b.exitCode === 0 ? b.stdout.trim() : null
    if (me.branch && !['main', 'master', 'HEAD'].includes(me.branch)) {
      const pr = await $.process.run(
        ['gh', 'pr', 'view', '--json', 'number,state', '-q', '"#" + (.number|tostring) + " " + .state'],
        { cwd: dir, timeoutMs: 10_000 },
      )
      me.pr = pr.exitCode === 0 ? pr.stdout.trim().toLowerCase().replace(/ open$/, '') : null
    } else {
      me.pr = null
    }
  } catch {
    // git or gh unavailable: keep what we had
  }
  await save($, true)
}

async function setPhase($: Engine, phase: Phase, why: string | null = null) {
  const now = await $.clock.now()
  me.phase = phase
  me.waitingWhy = phase === 'waiting' ? why : null
  me.waitingSince = phase === 'waiting' ? (me.waitingSince ?? now) : null
  await save($, true)
  $.ui.invalidate('ui.render')
}

// Toast when another session starts waiting; redraw the pane and band.
async function tick($: Engine) {
  const now = await $.clock.now()
  for (const r of await all($)) {
    if (r.id === me.id || !isAlive(r, now) || r.phase !== 'waiting' || !r.waitingSince) continue
    if (toasted.get(r.id) === r.waitingSince) continue
    toasted.set(r.id, r.waitingSince)
    $.ui.toast(`Needs you: ${r.task || r.id.slice(0, 8)} (${r.waitingWhy ?? 'waiting'})`, {
      timeoutMs: 8000,
    })
  }
  $.ui.invalidate('ui.render')
}

// Show another desktop session: the app's own deep link, as a sidebar click
async function switchTo($: Engine, r: Rec) {
  if (!r.hostId || !/^[\w-]+$/.test(r.hostId)) return
  try {
    const res = await $.process.run(['open', `claude://claude.ai/epitaxy/${r.hostId}`], { timeoutMs: 5000 })
    if (res.exitCode !== 0) $.ui.toast(`Could not switch to ${r.task || r.id.slice(0, 8)}`)
  } catch {
    $.ui.toast(`Could not switch to ${r.task || r.id.slice(0, 8)}`)
  }
}

export const register: Register = (on, options) => {
  pillRules = parseRules(typeof options.projectPills === 'string' ? options.projectPills : '')

  on('session.start', async ($, e, next) => {
    me.id = await $.session.id()
    me.cwd = await $.session.cwd()
    const prior = (await $.store.get(PREFIX + me.id)) as Rec | undefined
    if (prior) Object.assign(me, prior, { phase: 'idle', waitingWhy: null, waitingSince: null })
    if (!me.task) {
      try {
        const first = (await $.session.messages()).find(
          m => m.role === 'user' && m.text && !m.text.startsWith('<'),
        )
        if (first) me.task = short(first.text, 70)
      } catch {
        // no transcript yet
      }
    }
    me.lastAt = me.lastAt || (await $.clock.now())
    try {
      const env = await $.process.run(['printenv', 'CLAUDE_CODE_HOST_SESSION_ID'], { timeoutMs: 3000 })
      me.hostId = env.exitCode === 0 && env.stdout.trim() ? env.stdout.trim() : null
    } catch {
      me.hostId = null
    }
    await save($, true)
    void refreshRepo($)

    await $.command.register({
      name: 'fleet',
      description: 'Show or hide the session fleet board',
    })
    await $.store.delete(LEGACY_AUTO_OPEN)
    if (!(await isPaneOpen($))) void openBoard($)

    for (const t of timers) t.cancel()
    timers = [
      $.clock.every(BEAT_MS, () => void save($, true)),
      $.clock.every(REDRAW_MS, () => void tick($)),
    ]
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    for (const t of timers) t.cancel()
    timers = []
    if (me.id) await $.store.delete(PREFIX + me.id)
    return next(e)
  })

  on('command.run', { command: 'fleet' }, async $ => {
    await toggleBoard($)
    return { text: (await isPaneOpen($)) ? 'Fleet board shown.' : 'Fleet board hidden.' }
  })

  // The band's toggle label follows the pane, however it closed
  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    if (e.id === PANE) {
      editing = null
      $.ui.invalidate('ui.render')
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    // The desktop app stamps typed prompts `unclassified`; good enough for a first title
    const human = !e.origin || HUMAN.has(e.origin.kind) || (!me.task && e.origin.kind === 'unclassified')
    if (human && !me.task && !e.text.startsWith('<')) me.task = short(e.text, 70)
    await setPhase($, 'working')
    return next(e)
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    await setPhase($, 'waiting', `permission: ${short(e.tool_name, 30)}`)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const call = e as unknown as { tool: string } & Record<string, unknown>
    const now = await $.clock.now()
    me.last = describe(call)
    me.lastAt = now

    // Any shell command run inside a worktree counts as working there (no guard)
    if (call.tool === 'Bash' && !(await target($, call))) {
      const here = await toplevel($, me.cwd || (await $.session.cwd()))
      if (here) me.claims[here] = { since: me.claims[here]?.since ?? now, lastTouch: now }
    }

    // Worktree claim guard
    const tree = await target($, call)
    if (tree) {
      const mine = me.claims[tree]
      const rivals = (await all($)).filter(
        r =>
          r.id !== me.id &&
          isAlive(r, now) &&
          r.claims[tree] &&
          now - r.claims[tree].lastTouch < CLAIM_MS &&
          (!mine || r.claims[tree].since < mine.since),
      )
      if (rivals.length > 0 && !allowed.has(tree)) {
        const r = rivals[0]!
        const rc = r.claims[tree]!
        const who = `"${r.task || r.id.slice(0, 8)}"${r.branch ? ` on ${r.branch}` : ''}`
        await setPhase($, 'waiting', `worktree clash: ${shortTree(tree)}`)
        let answer = 'Stop'
        try {
          answer = await $.ui.ask(
            `Session ${who} claimed ${shortTree(tree)} ${ago(now, rc.since)} ago (last: ${r.last}, ${ago(now, r.lastAt)} ago). Write there anyway?`,
            {
              header: 'Worktree',
              options: ['Proceed for this session', 'Stop'],
            },
          )
        } catch (err) {
          // Dismissed, or nobody to ask. Only a true headless run (no surfaces and
          // not a desktop session) proceeds; the desktop app reports no surfaces
          // to the mod, so there an unanswerable ask must stop, not wave it through.
          const surfaces = await $.session.surfaces()
          $.ui.log(
            `session-fleet: guard ask failed (${String(err)}); surfaces=[${surfaces.join(',')}] hostId=${me.hostId ?? 'null'}`,
            { to: 'debug' },
          )
          answer = surfaces.length === 0 && !me.hostId ? 'Proceed for this session' : 'Stop'
        }
        await setPhase($, 'working')
        if (answer !== 'Proceed for this session') {
          return {
            deny: `session-fleet: another live session (${who}, last action "${r.last}") is working in ${tree}. Ask the user before writing there, or use a separate worktree.`,
          }
        }
        allowed.add(tree)
      }
      me.claims[tree] = { since: mine?.since ?? now, lastTouch: now }
    }
    // Release claims nobody has touched for a while
    for (const [k, c] of Object.entries(me.claims)) if (now - c.lastTouch > CLAIM_MS) delete me.claims[k]

    const asking = e.tool === 'AskUserQuestion'
    if (asking) await setPhase($, 'waiting', 'question')
    else await save($)

    const ran = await next(e)
    if (asking || me.phase === 'waiting') await setPhase($, 'working')
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const tail = e.answer.trim().slice(-400)
    const question = /\?\s*(\*\*)?\s*$/.test(tail) || /\?\s*\n[^\n]{0,80}$/.test(tail)
    if (question) {
      const q = tail.split(/(?<=[.!\n])\s+/).filter(s => s.includes('?')).pop() ?? 'question'
      await setPhase($, 'waiting', `asked: ${short(q, 60)}`)
    } else {
      await setPhase($, 'idle')
    }
    void refreshRepo($)
    return next(e)
  })

  // 2. Needs-you beacon above the prompt
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const now = await $.clock.now()
    const recs = await all($)
    const live = recs.filter(r => isAlive(r, now))
    const waiting = live.filter(r => r.id !== me.id && r.phase === 'waiting')
    const { Box, Text, Button } = $.ui.resolve(e)
    const paneShown = await isPaneOpen($)
    const toggle = (
      <Button
        key="toggle-fleet"
        label={paneShown ? `▾ Hide fleet board` : `▸ Fleet board · ${live.length} live`}
        plain
        dimColor
        onPress={() => void toggleBoard($)}
      />
    )
    if (waiting.length === 0)
      return (
        <Box flexDirection="column">
          <Box>{toggle}</Box>
          {below}
        </Box>
      )
    const width = Math.max(30, (e.props.bodyColumns ?? 80) - 20)
    const names = new Map<string, string>()
    for (const r of waiting) names.set(r.id, await nameOf($, r))
    return (
      <Box flexDirection="column">
        {waiting.slice(0, 3).map(r => (
          <Box key={r.id} gap={1}>
            <Text color={NEEDS_FG} backgroundColor={NEEDS_BG} bold>
              {' ⚑ NEEDS YOU '}
            </Text>
            <Text>
              {short(
                `${names.get(r.id)} · ${r.waitingWhy ?? 'waiting'} · ${ago(now, r.waitingSince ?? r.lastAt)}`,
                width - 16,
              )}
            </Text>
            {r.hostId && (
              <Button key={`band-go-${r.id}`} label="Switch →" variant="primary" onPress={() => void switchTo($, r)} />
            )}
          </Box>
        ))}
        <Box gap={1}>
          {waiting.length > 3 && <Text dimColor>+{waiting.length - 3} more</Text>}
          {toggle}
        </Box>
        {below}
      </Box>
    )
  })

  // 1. Fleet board pane
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : null // mobile draws no field
    const now = await $.clock.now()
    const order: Record<Phase, number> = { waiting: 0, working: 1, idle: 2 }
    const live = (await all($))
      .filter(r => isAlive(r, now))
      .sort((a, b) => order[a.phase] - order[b.phase] || b.lastAt - a.lastAt)
    const cols = Math.max(30, e.props.bodyColumns ?? 60)
    const dot: Record<Phase, string> = { waiting: '⚑', working: '●', idle: '○' }
    const color: Record<Phase, string> = { waiting: 'yellow', working: 'green', idle: 'gray' }
    const names = new Map<string, string>()
    for (const r of live) names.set(r.id, await nameOf($, r))

    // Worktrees held by more than one live session
    const holders = new Map<string, number>()
    for (const r of live)
      for (const [t, c] of Object.entries(r.claims))
        if (now - c.lastTouch < CLAIM_MS) holders.set(t, (holders.get(t) ?? 0) + 1)

    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          {live.length} live · {live.filter(r => r.phase === 'waiting').length} waiting on you
        </Text>
        {live.map(r => {
          const trees = Object.entries(r.claims)
            .filter(([, c]) => now - c.lastTouch < CLAIM_MS)
            .map(([t]) => (holders.get(t)! > 1 ? `⚠ ${shortTree(t)}` : shortTree(t)))
          const where = trees.length ? trees.join(', ') : home(r.cwd)
          const name = names.get(r.id)!
          const canSwitch = !!r.hostId && r.id !== me.id
          const waitingOnMe = r.phase === 'waiting'
          const p = pill(r, now)
          const startRename = () => {
            editing = r.id
            $.ui.invalidate('ui.render')
            void $.ui.focus({ requestId: PANE, key: `rename-${r.id}` }).catch(() => undefined)
          }
          return (
            <Box
              key={`card-${r.id}`}
              flexDirection="column"
              paddingX={1}
              borderStyle="round"
              borderColor={waitingOnMe ? NEEDS_BG : 'gray'}
            >
              {waitingOnMe && (
                <Box gap={1}>
                  <Text color={NEEDS_FG} backgroundColor={NEEDS_BG} bold>
                    {' ⚑ NEEDS YOU '}
                  </Text>
                  <Text color="yellow" bold>
                    {short(`${r.waitingWhy ?? 'waiting'} · ${ago(now, r.waitingSince ?? r.lastAt)}`, cols - 20)}
                  </Text>
                </Box>
              )}
              <Box gap={1}>
                <Text color={color[r.phase]}>{dot[r.phase]}</Text>
                {p ? <Text color={p.fg} backgroundColor={p.bg} bold>{` ${p.label} `}</Text> : null}
                <Text bold>{short(name, cols - 24)}</Text>
                {r.id === me.id && <Text dimColor>(this session)</Text>}
              </Box>
              <Text dimColor>{`  ${short(where, cols - 4)}`}</Text>
              <Text dimColor>{`  ${short([r.branch, r.pr].filter(Boolean).join(' · ') || 'no branch', cols - 4)}`}</Text>
              <Text dimColor>{`  ${short(`${r.last} · ${ago(now, r.lastAt)} ago`, cols - 4)}`}</Text>
              {editing === r.id && Input ? (
                <Box gap={1} key={`edit-${r.id}`}>
                  <Input
                    key={`rename-${r.id}`}
                    value={name === '(no prompt yet)' ? '' : name}
                    placeholder="Session name (empty resets it)"
                    submitLabel="Save"
                    autoFocus
                    onSubmit={(v: string) => void rename($, r.id, v)}
                  />
                  <Button
                    key={`cancel-${r.id}`}
                    label="Cancel"
                    variant="secondary"
                    onPress={() => {
                      editing = null
                      $.ui.invalidate('ui.render')
                    }}
                  />
                </Box>
              ) : (
                <Box gap={1}>
                  {canSwitch && (
                    <Button
                      key={`go-${r.id}`}
                      label={waitingOnMe ? 'Switch → answer it' : 'Switch →'}
                      variant="primary"
                      onPress={() => void switchTo($, r)}
                    />
                  )}
                  {Input && (
                    <Button key={`name-${r.id}`} label="✎ Rename" variant="secondary" onPress={startRename} />
                  )}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
