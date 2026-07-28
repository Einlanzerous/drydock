-- DRY-56: how a session ended, which exit_code cannot say.
--
-- 001 reserved pty_sessions with `exit_code` and called the follow-up a
-- code-only change. That stopped being true when DRY-57 landed: signalling a
-- process exits it non-zero (129 for HUP, 137 for KILL, 143 for TERM), so a
-- session somebody stopped on purpose and one that crashed are indistinguishable
-- from the code alone.
--
-- DRY-49 already paid for that confusion once. Inferring failure from a non-zero
-- exit made every deliberate stop post "failed — exited 129 … nobody was
-- watching when this stopped, please pick it up" to its ticket. A tombstone
-- reading "failed" for a window you closed by hand is the same bug wearing a
-- different surface, and the information to prevent it exists only while the
-- daemon still holds the session — so it gets written here, not derived later.
--
-- Text rather than an enum: the values mirror session.ts's RunEndReason, which
-- is UI vocabulary and has changed once already (DRY-18 refused to let "done"
-- mean "ended its turn"). A check constraint here would mean a migration every
-- time that wording moves, to buy nothing the writer doesn't already guarantee.
alter table pty_sessions add column if not exists end_reason text;

-- Retention scans by age and history is append-mostly, so the read pattern is
-- "this owner's rows, newest first" (already indexed by 001) and "everything
-- older than X" (this one). Partial on ended_at because a running session is
-- never a prune candidate.
create index if not exists pty_sessions_ended_idx
  on pty_sessions (ended_at)
  where ended_at is not null;
