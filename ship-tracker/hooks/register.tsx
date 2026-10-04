import type { EngineInterface as Engine, Register, Timer } from 'claude-code'

// ship-tracker:
//   3. a band above the prompt following each PR this session touched:
//      web: CI → merged → production deployment of the merge commit → live
//      iOS: CI → merged → TestFlight build (first upload after the merge)
//           → App Store (review → live), read from the repo's read-only
//           `fastlane ios ship_status` lane
//   7. a receipt line under each answer: duration, tools, files edited,
//      commands, outward-facing writes, subagents, context fill

const POLL_MS = 45_000
const MISSING_AFTER_MS = 15 * 60_000 // merged with no prod deployment by now = trigger died
const SHOW_DONE_MS = 30 * 60_000 // keep a finished PR in the band this long
const IOS_POLL_MS = 3 * 60_000 // App Store Connect via fastlane: slower, and states change slowly

type Stage = 'todo' | 'run' | 'ok' | 'fail'
type Ci = 'none' | 'running' | 'pass' | 'fail'
type Deploy = 'none' | 'pending' | 'success' | 'failure' | 'missing'

type Pr = {
  repo: string
  number: number
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  ci: Ci
  sha: string | null
  mergedAt: number | null
  deploy: Deploy
  deployUrl: string | null
  doneAt: number | null
  hidden: boolean
  // iOS repos (no deployments): App Store Connect state for the first
  // TestFlight build uploaded after the merge.
  kind?: 'web' | 'ios'
  tfBuild?: string | null
  tfState?: string | null
  storeState?: string | null
  storeVersion?: string | null
  iosError?: string | null
}

type ShipStatus = {
  builds: Array<{ version: string; build: string; state: string; uploaded: string; expired: boolean }>
  versions: Array<{ version: string; state: string; build: string | null }>
}

let sessionKey = ''
let prs: Pr[] = []
let timers: Timer[] = []
let polling = false
const kinds = new Map<string, 'web' | 'ios'>() // repo -> kind
const shipStatus = new Map<string, { at: number; data: ShipStatus | null; error: string | null }>()

// Per-turn receipt counters
let tools = 0
let failed = 0
let cmds = 0
let agents = 0
let files = new Set<string>()
let outward: string[] = []

const OUTWARD_MCP =
  /^(post|patch|put|create|update|delete|send|publish|apply|execute|upload|trash|merge|fire|schedule|bind|set|reply|forward|share|deploy|log)_/
const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g
const PR_REF = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/g

const short = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

const mins = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`
  return `${Math.floor(s / 3600)}h${Math.round((s % 3600) / 60)}m`
}

async function persist($: Engine) {
  if (sessionKey) await $.store.set(sessionKey, prs)
}

function track(repo: string, number: number) {
  if (prs.some(p => p.repo === repo && p.number === number)) return false
  prs.push({
    repo,
    number,
    title: '',
    state: 'OPEN',
    ci: 'none',
    sha: null,
    mergedAt: null,
    deploy: 'none',
    deployUrl: null,
    doneAt: null,
    hidden: false,
  })
  prs = prs.slice(-6)
  return true
}

function discover(text: string, allowRefs: boolean) {
  let found = false
  for (const m of text.matchAll(PR_URL)) found = track(m[1]!, Number(m[2])) || found
  if (allowRefs) for (const m of text.matchAll(PR_REF)) found = track(m[1]!, Number(m[2])) || found
  return found
}

async function gh($: Engine, args: string[]): Promise<unknown> {
  const r = await $.process.run(['gh', ...args], { timeoutMs: 20_000 })
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `gh exited ${r.exitCode}`)
  return JSON.parse(r.stdout)
}

type Check = { status?: string; conclusion?: string; state?: string }

function ciOf(checks: Check[]): Ci {
  if (checks.length === 0) return 'none'
  const bad = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])
  if (checks.some(c => bad.has(c.conclusion ?? '') || bad.has(c.state ?? ''))) return 'fail'
  if (checks.some(c => (c.status && c.status !== 'COMPLETED') || c.state === 'PENDING' || c.state === 'EXPECTED'))
    return 'running'
  return 'pass'
}

async function kindOf($: Engine, repo: string): Promise<'web' | 'ios'> {
  const known = kinds.get(repo)
  if (known) return known
  let kind: 'web' | 'ios' = 'web'
  try {
    const langs = (await gh($, ['api', `repos/${repo}/languages`])) as Record<string, number>
    const top = Object.entries(langs).sort((a, b) => b[1] - a[1])[0]?.[0]
    if (top === 'Swift' || top === 'Objective-C') kind = 'ios'
  } catch {
    // unknown: treat as web, the old behaviour
  }
  kinds.set(repo, kind)
  return kind
}

/** The session's checkout of `repo`, if the session is in one. */
async function checkoutOf($: Engine, repo: string): Promise<string | null> {
  const cwd = await $.session.cwd()
  const top = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
  if (top.exitCode !== 0) return null
  const root = top.stdout.trim()
  const origin = await $.process.run(['git', '-C', root, 'remote', 'get-url', 'origin'], { timeoutMs: 5000 })
  const slug = origin.stdout.trim().replace(/\.git$/, '')
  return slug.toLowerCase().endsWith(repo.toLowerCase()) ? root : null
}

/** App Store Connect state via the repo's `ship_status` lane, cached per repo. */
async function iosStatusOf($: Engine, repo: string, now: number) {
  const cached = shipStatus.get(repo)
  if (cached && now - cached.at < IOS_POLL_MS) return cached
  let entry: { at: number; data: ShipStatus | null; error: string | null }
  const root = await checkoutOf($, repo)
  if (!root) {
    entry = { at: now, data: null, error: 'no local checkout in this session' }
  } else {
    const r = await $.process.run(['fastlane', 'ios', 'ship_status'], {
      cwd: root,
      timeoutMs: 120_000,
      env: { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', FASTLANE_SKIP_UPDATE_CHECK: '1', FASTLANE_HIDE_CHANGELOG: '1' },
    })
    const line = r.stdout.split('\n').find(l => l.includes('SHIP_STATUS_JSON:'))
    if (line) {
      entry = { at: now, data: JSON.parse(line.slice(line.indexOf('SHIP_STATUS_JSON:') + 17)) as ShipStatus, error: null }
    } else {
      const noLane = /Could not find lane|ship_status/.test(r.stdout + r.stderr) && r.exitCode !== 0
      entry = { at: now, data: null, error: noLane ? 'no ship_status lane in the Fastfile' : `fastlane exited ${r.exitCode}` }
    }
  }
  shipStatus.set(repo, entry)
  return entry
}

const STORE_LIVE = new Set(['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION'])
const STORE_REVIEW = new Set(['WAITING_FOR_REVIEW', 'IN_REVIEW'])
const STORE_APPROVED = new Set(['PENDING_DEVELOPER_RELEASE', 'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_DISTRIBUTION', 'PROCESSING_FOR_APP_STORE'])
const STORE_REJECTED = new Set(['REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'])

async function refreshIos($: Engine, p: Pr, now: number) {
  const before = { tfBuild: p.tfBuild, tfState: p.tfState, storeState: p.storeState }
  const st = await iosStatusOf($, p.repo, now)
  p.iosError = st.error
  if (!st.data || !p.mergedAt) return
  // The first build uploaded after the merge is the first one carrying it.
  const merged = p.mergedAt
  const build = st.data.builds
    .filter(b => Date.parse(b.uploaded) >= merged)
    .sort((a, b) => Date.parse(a.uploaded) - Date.parse(b.uploaded))[0]
  p.tfBuild = build?.build ?? null
  p.tfState = build?.state ?? null
  const n = build ? Number(build.build) : NaN
  const version = Number.isNaN(n) ? undefined : st.data.versions.find(v => v.build !== null && Number(v.build) >= n)
  p.storeState = version?.state ?? null
  p.storeVersion = version?.version ?? build?.version ?? null

  if ((p.storeState && (STORE_LIVE.has(p.storeState) || STORE_REJECTED.has(p.storeState))) && !p.doneAt) p.doneAt = now

  const tag = `#${p.number}`
  if (!before.tfBuild && p.tfBuild) $.ui.toast(`${tag}: in TestFlight build ${p.tfBuild}${p.tfState === 'VALID' ? '' : ', processing'}`)
  if (before.tfState !== p.tfState && p.tfState === 'VALID' && before.tfBuild)
    $.ui.toast(`${tag}: build ${p.tfBuild} processed, ready to test`, { timeoutMs: 10_000 })
  if (before.tfState !== p.tfState && (p.tfState === 'FAILED' || p.tfState === 'INVALID'))
    $.ui.toast(`${tag}: TestFlight build ${p.tfBuild} ${p.tfState}`, { timeoutMs: 15_000 })
  if (before.storeState !== p.storeState && p.storeState) {
    if (STORE_REVIEW.has(p.storeState)) $.ui.toast(`${tag}: ${p.storeVersion} in App Review`)
    if (p.storeState === 'PENDING_DEVELOPER_RELEASE') $.ui.toast(`${tag}: ${p.storeVersion} approved, waiting for you to release`, { timeoutMs: 15_000 })
    if (STORE_LIVE.has(p.storeState)) $.ui.toast(`${tag}: live in the App Store`, { timeoutMs: 10_000 })
    if (STORE_REJECTED.has(p.storeState)) $.ui.toast(`${tag}: ${p.storeVersion} rejected (${p.storeState})`, { timeoutMs: 15_000 })
  }
}

async function refreshOne($: Engine, p: Pr, now: number) {
  const before = { ci: p.ci, state: p.state, deploy: p.deploy }
  const v = (await gh($, [
    'pr', 'view', String(p.number), '-R', p.repo,
    '--json', 'number,title,state,mergeCommit,mergedAt,statusCheckRollup',
  ])) as {
    title: string
    state: Pr['state']
    mergeCommit: { oid: string } | null
    mergedAt: string | null
    statusCheckRollup: Check[] | null
  }
  p.title = v.title
  p.state = v.state
  if (p.state !== 'MERGED') p.ci = ciOf(v.statusCheckRollup ?? [])
  if (p.state === 'MERGED') {
    p.sha = v.mergeCommit?.oid ?? null
    p.mergedAt = v.mergedAt ? Date.parse(v.mergedAt) : p.mergedAt ?? now
    if (p.ci === 'running' || p.ci === 'none') p.ci = ciOf(v.statusCheckRollup ?? [])
  }

  if (!p.kind) {
    p.kind = await kindOf($, p.repo)
    if (p.kind === 'ios') {
      // iOS has no deployments: drop whatever the web path concluded.
      p.deploy = 'none'
      p.deployUrl = null
      p.doneAt = null
    }
  }
  if (p.kind === 'ios') {
    if (p.state === 'MERGED') await refreshIos($, p, now)
    else if (p.state === 'CLOSED' && !p.doneAt) p.doneAt = now
    const tag = `#${p.number}`
    if (before.ci !== p.ci && p.ci === 'fail') $.ui.toast(`${tag}: CI failed`, { timeoutMs: 10_000 })
    if (before.ci !== p.ci && p.ci === 'pass' && p.state === 'OPEN') $.ui.toast(`${tag}: CI green`)
    if (before.state !== p.state && p.state === 'MERGED') $.ui.toast(`${tag}: merged, waiting for a TestFlight upload`)
    return
  }

  if (p.state === 'MERGED' && p.sha) {
    const deps = (await gh($, ['api', `repos/${p.repo}/deployments?sha=${p.sha}&per_page=20`])) as Array<{
      environment: string
      statuses_url: string
    }>
    const prod = deps.find(d => /prod/i.test(d.environment))
    if (!prod) {
      p.deploy = now - (p.mergedAt ?? now) > MISSING_AFTER_MS ? 'missing' : 'pending'
    } else {
      const st = (await gh($, ['api', `${prod.statuses_url}?per_page=1`])) as Array<{
        state: string
        environment_url?: string
        target_url?: string
      }>
      const s = st[0]
      p.deploy = !s
        ? 'pending'
        : s.state === 'success'
          ? 'success'
          : s.state === 'failure' || s.state === 'error'
            ? 'failure'
            : 'pending'
      p.deployUrl = s?.environment_url || s?.target_url || null
    }
  }

  const finished =
    p.state === 'CLOSED' || p.deploy === 'success' || p.deploy === 'failure' ||
    (p.deploy === 'missing' && now - (p.mergedAt ?? now) > 4 * MISSING_AFTER_MS)
  if (finished && !p.doneAt) p.doneAt = now

  // Toast the transitions worth looking up for
  const tag = `#${p.number}`
  if (before.ci !== p.ci && p.ci === 'fail') $.ui.toast(`${tag}: CI failed`, { timeoutMs: 10_000 })
  if (before.ci !== p.ci && p.ci === 'pass' && p.state === 'OPEN') $.ui.toast(`${tag}: CI green`)
  if (before.state !== p.state && p.state === 'MERGED') $.ui.toast(`${tag}: merged, waiting for the production build`)
  if (before.deploy !== p.deploy && p.deploy === 'failure')
    $.ui.toast(`${tag}: production deployment FAILED`, { timeoutMs: 15_000 })
  if (before.deploy !== p.deploy && p.deploy === 'missing')
    $.ui.toast(`${tag}: merged ${mins(now - (p.mergedAt ?? now))} ago and no production deployment yet. Check the Vercel git trigger.`, {
      timeoutMs: 15_000,
    })
  if (before.deploy !== p.deploy && p.deploy === 'success') $.ui.toast(`${tag}: live in production`, { timeoutMs: 8000 })
}

async function poll($: Engine) {
  if (polling) return
  polling = true
  try {
    const now = await $.clock.now()
    let changed = false
    for (const p of prs) {
      // Unclassified PRs (saved before iOS support) get one more look even
      // if the old "no prod deployment" timeout already finished them.
      if (p.hidden || (p.doneAt && p.kind)) continue
      try {
        await refreshOne($, p, now)
        changed = true
      } catch (err) {
        $.ui.log(`ship-tracker: #${p.number}: ${String(err).slice(0, 200)}`, { to: 'debug' })
      }
    }
    if (changed) {
      await persist($)
      $.ui.invalidate('ui.render')
    }
  } finally {
    polling = false
  }
}

const stageCi = (p: Pr): Stage =>
  p.ci === 'pass' ? 'ok' : p.ci === 'fail' ? 'fail' : p.ci === 'running' ? 'run' : 'todo'
const stageMerge = (p: Pr): Stage => (p.state === 'MERGED' ? 'ok' : p.state === 'CLOSED' ? 'fail' : 'todo')
const stageBuild = (p: Pr): Stage =>
  p.deploy === 'success' ? 'ok' : p.deploy === 'failure' || p.deploy === 'missing' ? 'fail' : p.state === 'MERGED' ? 'run' : 'todo'
const stageLive = (p: Pr): Stage => (p.deploy === 'success' ? 'ok' : p.deploy === 'failure' ? 'fail' : 'todo')

const stageTf = (p: Pr): Stage =>
  p.tfState === 'VALID'
    ? 'ok'
    : p.tfState === 'FAILED' || p.tfState === 'INVALID'
      ? 'fail'
      : p.state === 'MERGED' && !p.iosError
        ? 'run'
        : 'todo'
const stageStore = (p: Pr): Stage => {
  const s = p.storeState
  if (!s) return 'todo'
  if (STORE_LIVE.has(s)) return 'ok'
  if (STORE_REJECTED.has(s)) return 'fail'
  if (STORE_REVIEW.has(s) || STORE_APPROVED.has(s)) return 'run'
  return 'todo'
}
const tfLabel = (p: Pr, now: number) => {
  if (p.state !== 'MERGED') return 'TestFlight'
  if (p.iosError) return 'TestFlight ?'
  if (!p.tfBuild) return `TestFlight upload ${p.mergedAt ? mins(now - p.mergedAt) : ''}`.trim()
  if (p.tfState === 'VALID') return `TestFlight ${p.tfBuild}`
  if (p.tfState === 'PROCESSING') return `TestFlight ${p.tfBuild} processing`
  return `TestFlight ${p.tfBuild} ${String(p.tfState ?? '').toLowerCase()}`
}
const storeLabel = (p: Pr) => {
  const s = p.storeState
  if (!s) return 'App Store'
  if (STORE_LIVE.has(s)) return 'App Store live'
  if (STORE_REVIEW.has(s)) return `${p.storeVersion ?? ''} in review`.trim()
  if (s === 'PENDING_DEVELOPER_RELEASE') return `${p.storeVersion ?? ''} approved: release it`.trim()
  if (STORE_APPROVED.has(s)) return `${p.storeVersion ?? ''} releasing`.trim()
  if (STORE_REJECTED.has(s)) return `${p.storeVersion ?? ''} rejected`.trim()
  return `App Store (${p.storeVersion ?? ''} ${s.toLowerCase().replace(/_/g, ' ')})`.replace(' )', ')')
}

const MARK: Record<Stage, string> = { todo: '○', run: '●', ok: '✓', fail: '✗' }
const COLOR: Record<Stage, string> = { todo: 'gray', run: 'yellow', ok: 'green', fail: 'red' }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionKey = `prs:${await $.session.id()}`
    prs = ((await $.store.get(sessionKey)) as Pr[] | undefined) ?? []
    for (const t of timers) t.cancel()
    timers = [$.clock.every(POLL_MS, () => void poll($))]
    await $.command.register({
      name: 'ship-track',
      description: 'Track a PR in the ship band: /ship-track 1107 or /ship-track owner/repo#1107',
      argumentHint: '<number | owner/repo#number | url>',
    })
    void poll($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    for (const t of timers) t.cancel()
    timers = []
    if (sessionKey) await $.store.delete(sessionKey)
    return next(e)
  })

  on('command.run', { command: 'ship-track' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (!discover(arg, true)) {
      const n = arg.match(/^#?(\d+)$/)?.[1]
      if (!n) return { text: 'Usage: /ship-track <number | owner/repo#number | PR url>' }
      try {
        const r = (await gh($, ['repo', 'view', '--json', 'nameWithOwner'])) as { nameWithOwner: string }
        track(r.nameWithOwner, Number(n))
      } catch {
        return { text: 'Not in a GitHub repo here; pass owner/repo#number.' }
      }
    }
    await persist($)
    void poll($)
    return { text: 'Tracking it in the ship band.' }
  })

  on('turn.start', async ($, e, next) => {
    tools = failed = cmds = agents = 0
    files = new Set()
    outward = []
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const call = e as unknown as { tool: string } & Record<string, unknown>
    const ran = await next(e)
    if (e.agentId !== undefined) return ran

    tools += 1
    if (ran.isError) failed += 1
    const fp = (call.file_path ?? call.notebook_path) as string | undefined
    if (['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(call.tool) && typeof fp === 'string' && !ran.isError)
      files.add(fp.split('/').pop() ?? fp)
    if (call.tool === 'Agent' || call.tool === 'Task') agents += 1

    let found = false
    if (call.tool === 'Bash' && typeof call.command === 'string') {
      cmds += 1
      const c = call.command
      if (!ran.isError) {
        if (/\bgh\s+pr\s+create\b/.test(c)) outward.push('PR opened')
        if (/\bgh\s+pr\s+merge\b/.test(c)) outward.push('PR merged')
        if (/\bgit\s+push\b/.test(c)) outward.push('git push')
        if (/\bvercel\b.*--prod\b/.test(c)) outward.push('vercel --prod')
      }
      if (/\bgh\s+pr\b/.test(c)) found = discover(`${c}\n${ran.text ?? ''}`, true)
    } else if (call.tool.startsWith('mcp__')) {
      const name = call.tool.split('__').pop() ?? call.tool
      if (OUTWARD_MCP.test(name) && !ran.isError) outward.push(name)
      if (/ccd_pr|github/i.test(call.tool)) found = discover(`${JSON.stringify(call)}\n${ran.text ?? ''}`, false)
    }
    if (found) {
      await persist($)
      void poll($)
    }
    return ran
  })

  // 7. Turn receipt
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    if (tools === 0 && e.durationMs < 20_000) return r

    const parts = [`⏱ ${mins(e.durationMs)}`, `${tools} tool${tools === 1 ? '' : 's'}`]
    if (files.size) {
      const names = [...files]
      parts.push(`edited ${names.length}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`)
    }
    if (cmds) parts.push(`${cmds} cmd${cmds === 1 ? '' : 's'}`)
    if (failed) parts.push(`${failed} failed`)
    if (outward.length) {
      const counts = new Map<string, number>()
      for (const o of outward) counts.set(o, (counts.get(o) ?? 0) + 1)
      parts.push(`out: ${[...counts].map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(', ')}`)
    }
    if (agents) parts.push(`${agents} agent${agents === 1 ? '' : 's'}`)
    try {
      const pct = (await $.session.usage()).context.percent
      if (typeof pct === 'number') parts.push(`ctx ${Math.round(pct)}%`)
    } catch {
      // usage unavailable
    }
    void poll($)
    $.ui.log(parts.join(' · '))
    return r
  })

  // 3. Ship band
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const now = await $.clock.now()
    const shown = prs.filter(p => !p.hidden && (!p.doneAt || now - p.doneAt < SHOW_DONE_MS))
    if (shown.length === 0) return below

    const { Box, Text, Button } = $.ui.resolve(e)
    const cols = e.props.bodyColumns ?? 80
    const step = (s: Stage, label: string) => (
      <Text color={COLOR[s]}>
        {MARK[s]} {label}
      </Text>
    )
    return (
      <Box flexDirection="column">
        {shown.map(p => {
          const build =
            p.deploy === 'missing'
              ? 'no prod deploy!'
              : p.state === 'MERGED' && p.deploy !== 'success' && p.deploy !== 'failure' && p.mergedAt
                ? `prod build ${mins(now - p.mergedAt)}`
                : 'prod build'
          return (
            <Box key={`${p.repo}#${p.number}`} gap={1}>
              <Text bold>#{p.number}</Text>
              {cols > 100 && <Text dimColor>{short(p.title || p.repo, Math.max(12, cols - 90))}</Text>}
              {step(stageCi(p), 'CI')}
              <Text dimColor>→</Text>
              {step(stageMerge(p), p.state === 'CLOSED' ? 'closed' : 'merged')}
              <Text dimColor>→</Text>
              {p.kind === 'ios' ? step(stageTf(p), tfLabel(p, now)) : step(stageBuild(p), build)}
              <Text dimColor>→</Text>
              {p.kind === 'ios' ? step(stageStore(p), storeLabel(p)) : step(stageLive(p), 'live')}
              <Button
                key={`hide-${p.number}`}
                label="×"
                plain
                dimColor
                onPress={async () => {
                  p.hidden = true
                  await persist($)
                  $.ui.invalidate('ui.render')
                }}
              />
            </Box>
          )
        })}
        {below}
      </Box>
    )
  })
}
