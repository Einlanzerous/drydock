-- DRY-28: daemon-owned workspace state.

-- owner_id is plain text, not a foreign key, and that is deliberate: until
-- DRY-27 ships accounts there is no users table to point at, and this daemon
-- writes the single constant "local" (DRYDOCK_OWNER). When accounts arrive the
-- value becomes a real user id — the column keeps its shape, so the two tickets
-- don't have to land together.
create table if not exists workspaces (
  owner_id   text        not null,
  name       text        not null,
  version    integer     not null,
  layout     text        not null,
  -- jsonb, not text: the daemon never reads inside this (see state/types.ts),
  -- but storing it typed means the NEXT thing that wants to — "which windows
  -- reference a dead session?" — can ask in SQL instead of parsing every row.
  windows    jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, name)
);

-- Reserved for the follow-up half of DRY-28 (resumable session tombstones).
-- NOTHING WRITES TO THIS YET — an empty table here means the feature hasn't
-- landed, not that your sessions were lost. It exists now so the migration
-- ordering is settled and the follow-up is a code-only change.
--
-- Named pty_sessions rather than sessions on purpose: DRY-27 brings auth, and
-- an auth "session" is a completely different thing that will want that name.
create table if not exists pty_sessions (
  id               uuid        primary key,
  owner_id         text        not null,
  command          text        not null,
  args             jsonb       not null default '[]'::jsonb,
  cwd              text        not null,
  repo             text,
  ticket           text,
  worktree         text,
  branch           text,
  title            text,
  -- `claude --resume <id>` needs the CLI's OWN session id, which is not the
  -- daemon's PtySession.id. Null until we capture it from the wrapped CLI.
  agent_session_id text,
  created_at       timestamptz not null default now(),
  last_active_at   timestamptz,
  ended_at         timestamptz,
  exit_code        integer
);

create index if not exists pty_sessions_owner_idx
  on pty_sessions (owner_id, created_at desc);
