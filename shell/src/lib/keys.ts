/**
 * Reading a keyboard chord off a KeyboardEvent.
 *
 * Two facts about modifiers that every chord in this app has to know, kept here
 * so they are learned once rather than per call site (DRY-71 — before this they
 * lived only in `isPaletteChord`'s comment, and the terminal's clipboard keys
 * rediscovered them):
 *
 * - **`altKey` must be excluded**, not ignored. AltGr reports `ctrlKey` AND
 *   `altKey` on Windows and Linux layouts, so a chord that only checks `ctrlKey`
 *   swallows AltGr+<letter> and stops it typing its real character.
 * - **`metaKey` is a different chord**, not a modifier on this one. On macOS
 *   Cmd+C/Cmd+V are the clipboard and xterm deliberately lets them through
 *   (its ctrl branch requires `!ev.metaKey`), so anything claiming Ctrl+… must
 *   not also claim Cmd+….
 */

/**
 * The letter a chord means, lower-cased — or null when the key isn't a letter.
 *
 * `ev.key` first: that is what the LAYOUT produced, which is what somebody means
 * by "Ctrl+Shift+C". Lower-casing rather than matching "C" keeps a chord working
 * under CapsLock, which reports an upper-case key with `shiftKey` false.
 *
 * `ev.code` — the physical US-QWERTY position — only as a FALLBACK, and only
 * where `ev.key` produced no Latin letter at all. Never as an alternative: OR-ing
 * the two means a layout that moves C somewhere else (Dvorak) matches both its
 * own C *and* whatever now sits in QWERTY's C position, so a pane would claim
 * and preventDefault an unrelated chord — on Dvorak that position types `j`,
 * i.e. Ctrl+Shift+J, the browser's console. As a fallback it only ever fires
 * where `ev.key` cannot answer: a Cyrillic or Greek layout, where the letter
 * isn't Latin and the physical position is the only thing left to match on.
 */
export function chordLetter(ev: KeyboardEvent): string | null {
  const key = ev.key?.toLowerCase();
  if (key && key.length === 1 && key >= "a" && key <= "z") return key;
  const physical = /^Key([A-Z])$/.exec(ev.code);
  return physical ? physical[1].toLowerCase() : null;
}

/**
 * Enter that means "do it" — and not the Enter that commits an IME composition.
 *
 * Choosing a candidate in an input method (Japanese, Chinese, Korean) is
 * confirmed with Enter, and the browser delivers that as a keydown too. A bare
 * `e.key === "Enter"` handler treats it as a submit, so somebody typing a
 * deny-reason or a project key in an IME sends it half-composed. Firefox sets
 * `isComposing` on it; `keyCode 229` is the older signal Safari still reports
 * for the keydown that ends a composition, so both are checked (DRY-105).
 *
 * Modifiers are the caller's business: the palette, for one, gives Shift+Enter
 * its own meaning.
 */
export function isPlainEnter(ev: KeyboardEvent): boolean {
  return ev.key === "Enter" && !ev.isComposing && ev.keyCode !== 229;
}
