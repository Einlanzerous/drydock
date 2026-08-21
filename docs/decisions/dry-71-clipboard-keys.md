# The terminal's clipboard keys (DRY-71)

`Ctrl+Shift+C` copies, `Ctrl+Shift+V` pastes, and `Ctrl+C` is still SIGINT.
One `attachCustomKeyEventHandler` in `TerminalPane.vue`, which is the only
place a `Terminal` is constructed. Harness: `scripts/verify/clipboard.mts`,
rig in its README — a browser, about 30 seconds.

1. **`navigator.clipboard` is not available where this runs.** It needs a
   secure context; prod is `http://<host>:5321` (docs/deploy.md). Anything
   written against it works on a dev box at localhost and silently does nothing
   in prod, which is the worst split available. Use clipboard EVENTS —
   `document.execCommand("copy")` dispatches a real `copy` at the focused
   helper textarea and xterm's own listener answers it with the selection.
   The harness takes the API away from the page so this can't regress quietly.
2. **A Linux dev box hides the case that matters.** xterm mirrors a MOUSE
   selection into that textarea to feed X11's PRIMARY selection, guarded by
   `Browser.isLinux` (`SelectionService.refresh`), so on Linux there is always
   a selection lying about and `queryCommandEnabled("copy")` is true for
   reasons that have nothing to do with the terminal. On Windows there is none
   and it is false. Test it by forcing `navigator.platform` to `Win32` before
   the app loads — and assert the override TOOK, on the mirror itself
   (`textarea.value` empty, its selection range collapsed) rather than on
   `window.getSelection()`, whose treatment of a textarea selection is a
   browser-version detail that can read "empty" for the wrong reason. Measured
   on Chromium and Firefox: the `copy` event fires either way, so the bare
   `execCommand` is the primary path — but its boolean is READ, and a false
   answer retries through an off-screen textarea. A copy that silently does
   nothing has no surface to report on.
3. **Most of what the ticket described as broken already worked.** Measured
   against xterm 5.5.0: `Ctrl+Shift+V` and `Shift+Insert` pasted, `Ctrl+Insert`
   copied. xterm's ctrl branch requires `!ev.shiftKey` and the `ev.key &&
   ctrlKey` fallback maps only `_` and `@`, so ctrl+shift+letter produces no
   key and `_keyDown` returns before `cancel()` — the obvious fix of returning
   `false` for those two is a **no-op that reads like the fix**. Only
   `Ctrl+Shift+C` was ever broken, because no browser generates a `copy` event
   for it. Don't add a handler for a key without first pressing it.
4. **The handler runs for keyup and keypress too**, and `_keyUp` reads a
   `false` as "don't refocus" — so a handler that answers every phase copies
   three times and leaves the terminal blurred. Guard on `ev.type`, and on
   `ev.repeat` as well: the palette chord already had to (DRY-43).
5. **Match the letter with `chordLetter`** (`shell/src/lib/keys.ts`), shared
   with `isPaletteChord`. `ev.key` is what the LAYOUT produced, which is what a
   chord means; `ev.code` is the physical US-QWERTY position and belongs only
   in the `ev.key`-produced-no-Latin-letter fallback. OR-ing the two makes a
   Dvorak keyboard claim TWO chords — its own C and whatever now sits where
   QWERTY's C was, which there is `j`, i.e. the browser console.
6. `Ctrl+V` stays SYN and `Ctrl+C` stays SIGINT on purpose, so the harness
   asserts both POSITIVELY. Seeing the `^V` needs `stty lnext undef` in the
   probe shell, or the line discipline's literal-next eats it and the check
   passes against anything.
7. **Chrome's inspect-element accelerator is not reserved**, verified by hand on
   Chrome for Windows (headless cannot answer it, and the web is confidently
   wrong in both directions). `preventDefault` on `Ctrl+Shift+C` suppresses it
   while the keyboard is in a pane, and the same chord elsewhere on the desk
   still opens DevTools — which is why the pane claims it unconditionally
   rather than only when something is selected. Narrowing that puts the
   inspector back on exactly the empty-selection press somebody makes by
   mistake.
8. **A pane whose cwd does not exist is the cruellest false negative here.**
   The daemon records the cwd it was handed, so the frame renders `~/<dir>` and
   the pane attaches normally — the PTY dies immediately and every keystroke
   afterwards vanishes into what looks like a working terminal, which reads
   exactly like the clipboard being broken. The harness makes its own
   directories, and `attached()` refuses DRY-41's exit banner as well as the
   reconnect badge.

