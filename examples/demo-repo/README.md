# Drydock demo repo

A throwaway working directory for exercising the PreToolUse approval loop.

1. Start the daemon (`npm run daemon`) and shell (`npm run shell`).
2. In the shell, set the working dir to this folder's absolute path and spawn a
   `claude` session (the `+ claude` button, after setting the cwd).
3. Claude Code will ask once whether you trust the hooks in `.claude/settings.json`
   — approve it.
4. Ask Claude to run a shell command, e.g. **"run `ls -la` for me"**.
5. The `Bash` tool trips the `PreToolUse` hook → the daemon holds the call open →
   **this pane's border turns red** with an Approve / Deny prompt.
6. Click **Approve** → the decision round-trips back as the hook's
   `permissionDecision` and Claude proceeds without ever showing its own TUI prompt.

Widen the `matcher` in `.claude/settings.json` (e.g. `"Bash|Write|Edit"`) to gate
more tools.
