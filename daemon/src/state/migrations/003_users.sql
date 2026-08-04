-- DRY-27: accounts.
--
-- The table 001_workspace.sql said was coming. `workspaces.owner_id` and
-- `pty_sessions.owner_id` are still plain text and still NOT foreign keys into
-- this, deliberately: the two tiers of this daemon share those tables, and on a
-- database with DRYDOCK_MULTI_USER unset every row is owned by the constant
-- "local" (DRYDOCK_OWNER), which is not a user and never will be. A foreign key
-- would make the single-user posture unrepresentable in its own schema.
create table if not exists users (
  id            uuid        primary key,
  name          text        not null,
  -- scrypt, self-describing (see auth/password.ts). Never a plaintext column,
  -- and never nullable: an account with no credential is an account anyone can
  -- log in as, and a null here would make that a runtime check somebody can
  -- forget rather than something the schema refuses.
  password_hash text        not null,
  -- Bumped to invalidate every token already issued for this user. Tokens are
  -- stateless (auth/tokens.ts), so this integer is the entire revocation story:
  -- a password change moves it, and every old token stops verifying.
  token_epoch   integer     not null default 1,
  created_at    timestamptz not null default now()
);

-- Case-insensitive uniqueness, enforced by the database rather than by a read
-- before the write. Two browsers creating "magos" at the same moment is a race a
-- select cannot win, and the cost of losing it is two accounts that look
-- identical in the UI and own different desks.
create unique index if not exists users_name_key on users (lower(name));
