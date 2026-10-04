import type { EngineInterface as Engine, Register } from 'claude-code'

// session-hygiene:
//   8. tripwires for the author's rules (edit RULES_CONFIG below for yours): a dim
//      transcript line + toast for the user,
//      and a reminder Claude reads after the tool result. Two rules hold the
//      call with a question instead (sourcing env files, the service-role key).
//  10. handoff card: each session snapshots its open loops (open PRs, dirty or
//      unpushed worktrees, a question left unanswered); a new session lists the
//      ones still open, re-checked live. /handoff shows them again.

// ---- RULES_CONFIG: these are the author's rules. Change them to match your repos. ----
// Repo path fragment whose builds and PR CI don't typecheck, so TypeScript edits need
// `npm run typecheck` before a push, and new top-level src/app pages need a middleware entry.
const STRICT_REPO = '/2024-blog/'
// Banned strings in written files, with the reason Claude is told.
const BANNED: Array<{ re: RegExp; name: string; why: string }> = [
  { re: /audiowide/i, name: 'Audiowide', why: 'The Audiowide font is banned everywhere; replace it with the system stack.' },
]
// ------------------------------------------------------------------------------------

const SNAP = 'h:'
const SNAP_MAX_AGE = 7 * 24 * 60 * 60_000
const QUIET_MS = 30 * 60_000 // a snapshot this fresh, not ended, is a session still at work

type Item =
  | { kind: 'pr'; repo: string; number: number; title: string }
  | { kind: 'dirty'; tree: string; count: number }
  | { kind: 'unpushed'; tree: string; branch: string; count: number }
  | { kind: 'question'; text: string }

type Snapshot = {
  sessionId: string
  task: string
  updatedAt: number
  ended: boolean
  items: Item[]
}

// ---- session state ----------------------------------------------------------
let sessionId = ''
let task = ''
const trees = new Set<string>()
const prs = new Map<string, { repo: string; number: number }>()
let lastQuestion: string | null = null
let shownHandoff = false

// tripwire state
const fired = new Set<string>()
let lastTsEdit = 0
let lastTypecheck = 0
let lastEdit = 0
let lastReview = 0
let lastBuildDepEdit = 0
let lastBuild = 0
let pendingNotify = false
let migrations = 0

const toplevelCache = new Map<string, string | null>()
const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g
const PR_REF = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/g
const HUMAN = new Set(['composer', 'bridge', 'sdk'])
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']

const short = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}
const dirname = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'
const shortTree = (p: string) => {
  const wt = p.match(/\.claude\/worktrees\/([^/]+)$/)
  if (wt) return `${(p.split('/.claude/')[0] ?? '').split('/').pop()}:${wt[1]}`
  return p.replace(/^\/Users\/[^/]+/, '~')
}
const ago = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

async function toplevel($: Engine, dir: string): Promise<string | null> {
  let d = dir
  for (let i = 0; i < 6 && d && d !== '/'; i++) {
    if (toplevelCache.has(d)) return toplevelCache.get(d) ?? null
    try {
      if (await $.fs.exists(d)) {
        const r = await $.process.run(['git', '-C', d, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
        const top = r.exitCode === 0 ? r.stdout.trim() : null
        toplevelCache.set(d, top)
        return top
      }
    } catch {
      return null
    }
    d = dirname(d)
  }
  return null
}

async function git($: Engine, tree: string, args: string[]): Promise<string | null> {
  try {
    const r = await $.process.run(['git', '-C', tree, ...args], { timeoutMs: 8000 })
    return r.exitCode === 0 ? r.stdout.trim() : null
  } catch {
    return null
  }
}

// ---- tripwires -------------------------------------------------------------

// Tell the user (transcript line + toast) once per key; return the text for Claude.
function trip($: Engine, key: string, forUser: string, forClaude: string): string | null {
  if (fired.has(key)) return null
  fired.add(key)
  $.ui.log(`⚠ ${forUser}`)
  $.ui.toast(forUser, { timeoutMs: 10_000 })
  return `[session-hygiene tripwire] ${forClaude}`
}

type Call = { tool: string } & Record<string, unknown>

// Rules checked before a call runs. Returns a deny when the user says stop.
async function before($: Engine, call: Call): Promise<string | null> {
  if (call.tool !== 'Bash' || typeof call.command !== 'string') return null
  const c = call.command
  const holds: Array<[RegExp, string]> = [
    [
      /(^|[;&|(]\s*)(source|\.)\s+[^\s;&|]*\.env\b|set\s+-a[\s\S]*\.env/,
      'This command sources an env file, loading every secret in it into the shell. Rule: read only the variables a script needs.',
    ],
    [
      /\$\{?\w*SERVICE_ROLE\w*|service_role_key\s*[=:]/i,
      'This command uses the Supabase service-role key against the production database. Rule: ask the user before any direct prod DB access, reads included.',
    ],
  ]
  for (const [re, why] of holds) {
    if (!re.test(c)) continue
    let answer = 'Stop'
    try {
      answer = await $.ui.ask(`${why} Run it anyway?`, { header: 'Tripwire', options: ['Run it', 'Stop'] })
    } catch {
      answer = 'Stop'
    }
    if (answer !== 'Run it') return `session-hygiene: the user stopped this command. ${why}`
  }
  return null
}

// Rules checked after a call ran. Returns reminders for Claude.
async function after($: Engine, call: Call, ok: boolean, isNewFile: boolean, now: number): Promise<string[]> {
  const out: Array<string | null> = []
  const fp = (call.file_path ?? call.notebook_path) as string | undefined

  if (WRITE_TOOLS.includes(call.tool) && typeof fp === 'string' && ok) {
    lastEdit = now
    if (/\.(ts|tsx)$/.test(fp) && fp.includes(STRICT_REPO)) lastTsEdit = now
    if (/\/(package\.json|next\.config\.[cm]?[jt]s)$/.test(fp)) lastBuildDepEdit = now

    const added = String(call.new_string ?? call.content ?? '')
    for (const b of BANNED)
      if (b.re.test(added))
        out.push(trip($, `banned:${b.name}:${fp}`, `${b.name} written into ${fp.split('/').pop()}`, `The text just written to ${fp} contains ${b.name}. ${b.why}`))

    if (isNewFile && /\.(test|spec)\.[cm]?[jt]sx?$/.test(fp))
      out.push(
        trip($, `mutation:${fp}`, `New test ${fp.split('/').pop()}: mutation-check it`,
          `${fp} is a new test file. Before claiming it covers anything, delete the production code it targets, confirm the test FAILS, then restore from a copy and confirm git diff is empty.`),
      )

    const rel = fp.includes(STRICT_REPO) ? fp.slice(fp.indexOf(STRICT_REPO) + STRICT_REPO.length) : ''
    const route = rel.match(/^(?:\.claude\/worktrees\/[^/]+\/)?src\/app\/([^/()[\]]+)\/(?:.*\/)?page\.tsx$/)
    if (isNewFile && route && !['saas-platform', 'api', 'admin'].includes(route[1]!))
      out.push(
        trip($, `route:${route[1]}`, `New page under src/app/${route[1]}: needs middleware passthrough`,
          `New page under src/app/${route[1]}/. In production it 404s unless /${route[1]}/ is added to BOTH host branches of the passthrough list in src/middleware.ts (localhost AND the production host branch). CI cannot catch this; curl the production URL after deploy.`),
      )
  }

  if (call.tool === 'Bash' && typeof call.command === 'string') {
    const c = call.command
    if (ok && /\b(npm|bun|pnpm)\s+run\s+typecheck\b|\btsc\b[^|;&]*--noEmit/.test(c)) lastTypecheck = now
    if (ok && /\b(npm|bun|pnpm)\s+run\s+build\b|\bnext\s+build\b/.test(c)) lastBuild = now

    const shipping = /\bgit\s+push\b|\bgh\s+pr\s+create\b/.test(c)
    if (shipping && lastTsEdit > lastTypecheck)
      out.push(
        trip($, `typecheck:${lastTsEdit}`, 'Pushed TypeScript edits without npm run typecheck',
          'TypeScript files were edited since the last `npm run typecheck`. Neither the build nor PR CI typechecks this repo, so a type error ships to production. Run `npm run typecheck` now and fix anything new.'),
      )
    if (/\bgit\s+push\b/.test(c) && lastEdit > lastReview)
      out.push(
        trip($, `review:${lastEdit}`, 'Pushed without a local /code-review since the last edit',
          'Code was pushed with edits made since the last local /code-review. Rule: run /code-review high before every branch\'s first push and after fixing a finding; every extra CI round costs paid Actions minutes.'),
      )
    if (/\bgh\s+pr\s+merge\b/.test(c) && lastBuildDepEdit > lastBuild)
      out.push(
        trip($, `build:${lastBuildDepEdit}`, 'Merging a build-config change without a local npm run build',
          'package.json or next.config changed this session and no local `npm run build` ran since. PR checks never build this repo (the Vercel preview step is ignored), so the production build after merge is the first real one.'),
      )
  }

  if (call.tool === 'Skill' && /code-review/.test(String(call.skill ?? ''))) lastReview = now
  if (call.tool === 'ReportFindings') lastReview = now

  if (/supabase__apply_migration$/.test(call.tool) && ok) {
    pendingNotify = true
    migrations += 1
    const q = String(call.query ?? '')
    out.push(
      trip($, `notify:${now}`, 'Migration applied: run NOTIFY pgrst',
        "A migration was just applied. Run `NOTIFY pgrst, 'reload schema';` via execute_sql now, then verify through the app's REST path, not raw SQL."),
    )
    if (/create\s+table/i.test(q) && !/revoke[\s\S]*from\s+authenticated/i.test(q))
      out.push(
        trip($, `grants:${now}`, 'New table keeps default authenticated grants',
          'This migration creates a table without revoking the default grants from `authenticated`. Supabase grants it SELECT/INSERT/UPDATE/DELETE by default, and `grant update` is not column-scoped. Revoke them explicitly and check information_schema.role_table_grants.'),
      )
  }
  if (/supabase__execute_sql$/.test(call.tool) && /notify\s+pgrst/i.test(String(call.query ?? ''))) pendingNotify = false

  return out.filter((x): x is string => x !== null)
}

// ---- handoff ---------------------------------------------------------------

function discover(text: string) {
  for (const m of text.matchAll(PR_URL)) prs.set(`${m[1]}#${m[2]}`, { repo: m[1]!, number: Number(m[2]) })
  for (const m of text.matchAll(PR_REF)) prs.set(`${m[1]}#${m[2]}`, { repo: m[1]!, number: Number(m[2]) })
}

async function prOpen($: Engine, repo: string, n: number): Promise<{ open: boolean; title: string } | null> {
  try {
    const r = await $.process.run(['gh', 'pr', 'view', String(n), '-R', repo, '--json', 'state,title'], { timeoutMs: 15_000 })
    if (r.exitCode !== 0) return null
    const v = JSON.parse(r.stdout) as { state: string; title: string }
    return { open: v.state === 'OPEN', title: v.title }
  } catch {
    return null
  }
}

async function treeItems($: Engine, tree: string): Promise<Item[]> {
  if (!(await $.fs.exists(tree))) return []
  const items: Item[] = []
  const status = await git($, tree, ['status', '--porcelain'])
  const dirty = status ? status.split('\n').filter(Boolean).length : 0
  if (dirty) items.push({ kind: 'dirty', tree, count: dirty })
  const branch = await git($, tree, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch && !['main', 'master', 'HEAD'].includes(branch)) {
    const n =
      (await git($, tree, ['rev-list', '--count', '@{u}..HEAD'])) ??
      (await git($, tree, ['rev-list', '--count', 'origin/main..HEAD']))
    if (n && Number(n) > 0) items.push({ kind: 'unpushed', tree, branch, count: Number(n) })
  }
  return items
}

async function snapshot($: Engine) {
  if (!sessionId) return
  const items: Item[] = []
  for (const p of prs.values()) {
    const s = await prOpen($, p.repo, p.number)
    if (s?.open) items.push({ kind: 'pr', repo: p.repo, number: p.number, title: s.title })
  }
  for (const t of trees) items.push(...(await treeItems($, t)))
  if (lastQuestion) items.push({ kind: 'question', text: lastQuestion })
  const snap: Snapshot = { sessionId, task, updatedAt: await $.clock.now(), ended: false, items }
  await $.store.set(SNAP + sessionId, snap)
}

// Re-check a snapshot's items now; drop what has since been resolved.
async function recheck($: Engine, s: Snapshot): Promise<Item[]> {
  const out: Item[] = []
  const seenTrees = new Set<string>()
  for (const it of s.items) {
    if (it.kind === 'pr') {
      const st = await prOpen($, it.repo, it.number)
      if (st?.open) out.push({ ...it, title: st.title })
    } else if (it.kind === 'dirty' || it.kind === 'unpushed') {
      if (seenTrees.has(it.tree)) continue
      seenTrees.add(it.tree)
      out.push(...(await treeItems($, it.tree)))
    } else if (it.kind === 'question' && (await $.clock.now()) - s.updatedAt < 2 * 24 * 60 * 60_000) {
      out.push(it)
    }
  }
  return out
}

const describeItem = (it: Item) =>
  it.kind === 'pr'
    ? `PR ${it.repo.split('/').pop()}#${it.number} still open (${short(it.title, 40)})`
    : it.kind === 'dirty'
      ? `${shortTree(it.tree)}: ${it.count} uncommitted file${it.count === 1 ? '' : 's'}`
      : it.kind === 'unpushed'
        ? `${shortTree(it.tree)}: ${it.count} unpushed commit${it.count === 1 ? '' : 's'} on ${it.branch}`
        : `left a question: ${short(it.text, 70)}`

async function handoffReport($: Engine): Promise<{ lines: string[]; keys: string[] }> {
  const now = await $.clock.now()
  const keys = (await $.store.keys()).filter((k: string) => k.startsWith(SNAP))
  const snaps: Snapshot[] = []
  for (const k of keys) {
    const s = (await $.store.get(k)) as Snapshot | undefined
    if (!s || s.sessionId === sessionId) continue
    if (now - s.updatedAt > SNAP_MAX_AGE) {
      await $.store.delete(k)
      continue
    }
    if (!s.ended && now - s.updatedAt < QUIET_MS) continue // still being worked on
    if (s.items.length) snaps.push(s)
  }
  snaps.sort((a, b) => b.updatedAt - a.updatedAt)

  const lines: string[] = []
  const shownKeys: string[] = []
  for (const s of snaps.slice(0, 6)) {
    const items = await recheck($, s)
    if (items.length === 0) {
      await $.store.delete(SNAP + s.sessionId)
      continue
    }
    await $.store.set(SNAP + s.sessionId, { ...s, items })
    shownKeys.push(SNAP + s.sessionId)
    lines.push(`↩ "${short(s.task || s.sessionId.slice(0, 8), 60)}" (${ago(now - s.updatedAt)} ago) left:`)
    for (const it of items.slice(0, 4)) lines.push(`    · ${describeItem(it)}`)
  }
  return { lines, keys: shownKeys }
}

// ---- hooks -------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    const prior = (await $.store.get(SNAP + sessionId)) as Snapshot | undefined
    if (prior) task = prior.task
    await $.command.register({
      name: 'handoff',
      description: 'Open loops left by earlier sessions (PRs, uncommitted or unpushed work, questions). /handoff clear dismisses them.',
      argumentHint: '[clear]',
    })
    if (!shownHandoff) {
      shownHandoff = true
      void handoffReport($).then(r => {
        if (r.lines.length) {
          for (const line of ['Open loops from earlier sessions (/handoff to see again, /handoff clear to dismiss):', ...r.lines])
            $.ui.log(line)
        }
      })
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const s = (await $.store.get(SNAP + sessionId)) as Snapshot | undefined
    if (s) await $.store.set(SNAP + sessionId, { ...s, ended: true })
    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const r = await handoffReport($)
    if ((e.args ?? '').trim() === 'clear') {
      for (const k of r.keys) await $.store.delete(k)
      return { text: r.keys.length ? `Dismissed open loops from ${r.keys.length} session(s).` : 'Nothing to dismiss.' }
    }
    return { text: r.lines.length ? r.lines.join('\n') : 'No open loops from earlier sessions.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const human = !e.origin || HUMAN.has(e.origin.kind)
    if (human && !e.text.startsWith('<')) {
      if (!task) task = short(e.text, 70)
      lastQuestion = null
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const call = e as unknown as Call
    const now = await $.clock.now()

    const deny = await before($, call)
    if (deny) return { deny }

    const fp = (call.file_path ?? call.notebook_path) as string | undefined
    const isNewFile = call.tool === 'Write' && typeof fp === 'string' && !(await $.fs.exists(fp))

    const ran = await next(e)
    if ('deny' in ran && ran.deny !== undefined) return ran
    const ok = !ran.isError

    // handoff bookkeeping
    if (WRITE_TOOLS.includes(call.tool) && typeof fp === 'string') {
      const t = await toplevel($, dirname(fp))
      if (t) trees.add(t)
    }
    if (call.tool === 'Bash' && typeof call.command === 'string') {
      const c = call.command
      if (/\bgit\b/.test(c)) {
        const dashC = c.match(/git\s+-C\s+("[^"]+"|'[^']+'|\S+)/)?.[1] ?? c.match(/(?:^|&&|;)\s*cd\s+("[^"]+"|'[^']+'|\S+)/)?.[1]
        const dir = dashC ? dashC.replace(/^["']|["']$/g, '') : await $.session.cwd()
        const t = await toplevel($, dir.startsWith('/') ? dir : `${await $.session.cwd()}/${dir}`)
        if (t) trees.add(t)
      }
      if (/\bgh\s+pr\b/.test(c)) discover(`${c}\n${ran.text ?? ''}`)
    }

    const reminders = await after($, call, ok, isNewFile, now)
    if (reminders.length === 0) return ran
    return { ...ran, context: [...(ran.context ?? []), ...reminders] }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    if (pendingNotify) {
      trip($, `notify-turn:${migrations}`, "Turn ended with a migration applied and no NOTIFY pgrst, 'reload schema'", '')
    }
    const tail = e.answer.trim().slice(-400)
    lastQuestion = /\?\s*(\*\*)?\s*$/.test(tail)
      ? (tail.split(/(?<=[.!\n])\s+/).filter(s => s.includes('?')).pop() ?? null)
      : null
    void snapshot($)
    return r
  })
}
