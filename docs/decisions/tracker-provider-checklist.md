# Verifying a tracker provider (Switchyard / Jira)

The tracker is host config; the browser only ever sees `/api/tracker/*`.
Checklist, using the second-instance pattern in `CLAUDE.md` with the provider's
env.

**Turn the caches OFF for all of it** (DRY-72) — add
`DRYDOCK_TRACKER_CACHE_MS=0 DRYDOCK_TRACKER_CHILD_STATS_CACHE_MS=0` to the env
below. This checklist tests the PROVIDER, and every curl in it now goes through
a cache that will happily answer the second one from the first. Steps 2-4 and 6
vary only the query params, so each is a distinct cache key and the first run of
each is honest — but re-run one inside the TTL and you are timing the cache.
Step 8 is the one that silently stops meaning anything: its whole assertion is
that `childStats` moves when the tracker moves, and against a five-minute child
TTL it won't for five minutes. That off switch exists for exactly this.

```sh
# Jira Cloud: email + API token → Basic auth
DRYDOCK_PORT=4399 DRYDOCK_TRACKER=jira \
  DRYDOCK_JIRA_URL=https://yourco.atlassian.net \
  DRYDOCK_JIRA_EMAIL=you@yourco.com DRYDOCK_JIRA_TOKEN=... \
  DRYDOCK_TRACKER_PROJECTS=SRE,SREREV,SREDESK \
  node --import tsx src/index.ts

# Jira Server/DC: personal access token ALONE (Bearer) — no email
```

Always set `DRYDOCK_TRACKER_PROJECTS` against a corporate tracker (DRY-30) —
unscoped, the sidebar query pulls every open ticket in the instance. Note the
boolean params are literal `true`, not `1`.

1. `curl -s localhost:4399/api/tracker/info` — provider id/name/capabilities +
   the configured default `projects`.
2. `curl -s "localhost:4399/api/tracker/tickets?open=true"` — the sidebar
   query: scoped to the default projects, backlog excluded; exercises search
   pagination (Cloud `/search/jql` + nextPageToken vs DC `/search` + startAt —
   the probe/fallback and every other Cloud/DC divergence is documented in
   `daemon/src/tracker/jira.ts`'s comments; read them before debugging).
3. `curl -s "localhost:4399/api/tracker/tickets?open=true&backlog=true"` — now
   backlog-bucket tickets appear too (the sidebar's `backlog` toggle).
4. `curl -s "localhost:4399/api/tracker/tickets?open=true&projects=SRE,FOO"` —
   explicit scope overrides the env default (the sidebar's added chips).
5. `curl -s "localhost:4399/api/tracker/search?q=<text>"` — palette/search
   query; project-scoped, but spans all statuses.
6. `curl -s "localhost:4399/api/tracker/tickets?project=<KEY>&open=true"` —
   single-project JQL clause.
7. `curl -s "localhost:4399/api/tracker/ticket/<KEY>"` for a ticket that HAS a
   component — `repo` must be the component slug (lowercase, spaces→dashes,
   DRY-31), not the project key; a component-less ticket falls back to the
   lowercased project key.
8. Epics (DRY-13), on the query from step 2 — the one WITHOUT `backlog=true`:
   every `type: epic` in scope must still come back, and each must carry
   `childStats` counting **all** its children by category. Both are easy to
   regress into something that looks fine:
   - Epics are exempted from the backlog exclusion, so a provider that folds
     the exemption into the wrong clause silently drops exactly the epics whose
     work hasn't started — the ones a child is left orphaned under. Assert an
     epic you know is in the backlog appears with `backlog=false`.
   - `childStats` must NOT come from the loaded tickets. Counting those is free
     and always wrong: the pull excludes done, so every epic reads 0-done. The
     numbers must move when the tracker moves and not when the toggle does.
   - Non-epics must have no `childStats`, and the palette (`/search`) must issue
     no child query at all — it has no `open` flag, so the pass must not fire.
   - Jira answers every epic in one `parent in (…)` search; Switchyard has no OR
     in its list filter, so it's one request per epic, through a small pool
     (`CHILD_STATS_POOL`). Bounding the epic *count* does not bound concurrency:
     each one is a cursor chain, so an unpooled fan-out opens dozens of them per
     sidebar refresh, per browser.
   - **A capped count must be abandoned, not truncated.** The child query spans
     every status, so `MAX_TICKETS` is reachable on an ordinary corporate Jira
     (20 epics × 100 children). Truncating leaves `childStats` present and
     wrong, and the shell renders it as authoritative — "13/40 done" when the
     truth is 13/78. Both providers bail instead. Drive it with a stub that
     always returns another page and assert `childStats` comes back UNSET.
   - Two queries here are allowed to fail and must stay harmless: `parent` isn't
     queryable on older Jira DC (child stats 400 — swallowed), and
     `issuetype = "Epic"` doesn't validate on an instance with no type named
     that, localized or renamed. The second is the dangerous one because it sits
     in the sidebar's *critical path*: unhandled it means an empty sidebar where
     one previously worked. It downgrades to the plain clause on a first-page
     400 and latches (`epicClauseUsable`), so the probe is paid once.
9. End-to-end: point a browser at the dev shell, switch it to the throwaway
   daemon port, open a ticket, **Send to agent** — verifies repo→cwd resolution
   (`DRYDOCK_REPOS_ROOT` / `DRYDOCK_REPO_PATHS`, keyed by component slug for
   Jira) and the SessionStart context injection.

There are no automated tests yet — these curls plus a ticket-spawn are the
regression suite. Don't claim a provider works until they all pass against a
real instance.

