// DRY-83: an epic expands to the work under it, not to whatever the pull
// happened to include.
//
// Why a browser and not curl: `/api/tracker/tickets?parent=DRY-10` returns the
// right rows the moment the daemon half is written, and that proves nothing
// about the bug. The bug was that the SIDEBAR had no way to ask — the epic row
// went inert, tooltip "no children to expand here", because the sidebar's own
// pull excludes the backlog bucket and exempts only the EPICS in it. An epic
// whose work hasn't started therefore arrives as a heading with nothing under
// it, and the only escape hatch was the backlog toggle, which changes the pull
// for the whole sidebar (~29 tickets to 250+ against a real tracker) to reach
// one epic's children.
//
// The rig's `STUB_DORMANT_EPIC=1` supplies exactly that shape: DRY-10, in the
// list because epics are exempt, with two backlog children and one closed one,
// none of which the list can contain. Setup: see README.md.
//
// What each section holds down, and why it isn't subsumed by the one before:
//
//   (a) the row can be expanded at all. The whole ticket. Fails against the
//       unpatched tree, where the row is `.inert` and has no chevron.
//   (b) what expanding SHOWS: the open children, and not the closed one. A
//       fetch that returned everything would look like a success and put a done
//       ticket on the list of work to pick up.
//   (c) it did not do this by widening the pull. The header count and the
//       backlog toggle are the two things that would have moved if it had, and
//       both are what the user was trying to avoid touching.
//   (d) a filter must not fan out. Filters force every epic open (`isEpicOpen`),
//       so a fetch driven off "is it open" fires one request per epic per
//       keystroke — the per-poll fan-out DRY-72 spent a ticket removing, back
//       one gesture at a time. Asserted on UPSTREAM counts, because the daemon's
//       cache would hide it from anything measured at the route.
//   (e) Refresh reaches the expanded epic. The one button somebody presses when
//       they have stopped trusting the screen must not freshen every row except
//       the ones they opened on purpose — those are the rows an agent gets
//       spawned from.
import { chromium } from "playwright";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5395";
const STUB = process.env.STUB_URL ?? "http://127.0.0.1:4396";
/** The epic the pull can show nothing under. */
const EPIC = process.env.EPIC ?? "DRY-10";
/** Its open children, and the closed one that must stay out. */
const OPEN_KIDS = (process.env.OPEN_KIDS ?? "DRY-11,DRY-12").split(",");
const CLOSED_KID = process.env.CLOSED_KID ?? "DRY-13";

let failures = 0;
function check(name, ok, extra = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? ` — ${extra}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stubState = () => fetch(`${STUB}/__state`).then((r) => r.json());
const stubReset = () => fetch(`${STUB}/__reset`, { method: "POST" }).then((r) => r.json());

/**
 * Poll until `fn` holds. Fixed sleeps are what make a browser harness flaky —
 * the ticket poll is on its own clock and a fetch takes as long as it takes, so
 * any constant is either a stall or a race.
 */
async function waitFor(fn, ms = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return Math.round((Date.now() - t0) / 100) / 10;
    await sleep(150);
  }
  return null;
}

/**
 * What the sidebar is showing.
 *
 * Rows are read as KEYS rather than counted. A count can be satisfied by the
 * wrong rows — and the failure mode here is specifically "the wrong set of
 * children", so the identities are the assertion.
 */
function snap(page) {
  return page.evaluate(() => {
    const txt = (el) => el?.textContent?.trim() ?? null;
    const epicRow = (key) =>
      [...document.querySelectorAll(".sidebar .row.epic")].find(
        (r) => txt(r.querySelector(".key")) === key,
      );
    const rows = [...document.querySelectorAll(".sidebar .row")];
    return {
      groups: document.querySelectorAll(".sidebar .grp").length,
      // The header's "shown/total", which describes the PULL. An expansion that
      // leaked into it would be the backlog toggle wearing a chevron.
      count: txt(document.querySelector(".sidebar .count")),
      backlogOn: !!document.querySelector(".sidebar .backlog input:checked"),
      // Every row on screen, in order, tagged by whether it is nested under an
      // epic — order matters (active work is meant to sort above dormant).
      rows: rows.map((r) => ({
        key: txt(r.querySelector(".key")),
        epic: r.classList.contains("epic"),
        child: r.classList.contains("child"),
        status: txt(r.querySelector(".slabel")),
      })),
      notes: [...document.querySelectorAll(".sidebar .child-note")].map((n) => n.textContent.trim()),
      epic: (() => {
        const r = epicRow(window.__EPIC__);
        if (!r) return null;
        return {
          inert: r.classList.contains("inert"),
          // The chevron is a <button> when there is something to reveal and a
          // bare <span class="empty"> when there isn't, so its presence — not
          // just the element — is the honest probe.
          chevron: !!r.querySelector("button.epic-chev"),
          open: !!r.querySelector("button.epic-chev.open"),
          title: r.getAttribute("title"),
        };
      })(),
    };
  });
}

const keysOf = (s) => s.rows.filter((r) => !r.epic).map((r) => r.key);
const childrenOf = (s) => s.rows.filter((r) => r.child).map((r) => r.key);

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  page.on("pageerror", (e) => check(`no page error (${e.message})`, false));
  await page.addInitScript(`window.__EPIC__ = ${JSON.stringify(EPIC)}`);
  await page.goto(SHELL, { waitUntil: "domcontentloaded" });

  // ---- (a) the epic row offers an expansion at all -------------------------
  console.log("\n(a) the row can be expanded");
  const drew = await waitFor(async () => (await snap(page)).groups > 0);
  check("the sidebar drew a repo group", drew !== null, drew === null ? "timed out" : `${drew}s`);

  // Groups render collapsed (DRY-55's trap 2 — `.row` counts nothing until one
  // is open), so open it before asserting on anything inside.
  await page.click(".sidebar .grp");
  await waitFor(async () => (await snap(page)).rows.length > 0);

  let s = await snap(page);
  check(`${EPIC} is on the rail`, s.epic !== null);
  check(
    `${EPIC} is not inert`,
    s.epic?.inert === false,
    s.epic?.inert ? `title: ${s.epic.title}` : "",
  );
  check(`${EPIC} has a chevron to click`, s.epic?.chevron === true);
  check(
    "and none of its children are in the pull",
    OPEN_KIDS.every((k) => !keysOf(s).includes(k)),
    `rows: ${keysOf(s).join(", ")}`,
  );

  const countBefore = s.count;
  const backlogBefore = s.backlogOn;

  // ---- (b) what it expands TO ---------------------------------------------
  console.log("\n(b) expanding fetches the open children");
  await page.click(`.sidebar .row.epic:has(.key:text-is("${EPIC}"))`);
  const got = await waitFor(async () => {
    const k = childrenOf(await snap(page));
    return OPEN_KIDS.every((x) => k.includes(x));
  });
  check(
    `${EPIC} expanded to ${OPEN_KIDS.join(" + ")}`,
    got !== null,
    got === null ? `saw: ${childrenOf(await snap(page)).join(", ") || "none"}` : `${got}s`,
  );

  s = await snap(page);
  check(
    `the closed child ${CLOSED_KID} stayed out`,
    !childrenOf(s).includes(CLOSED_KID),
    `children: ${childrenOf(s).join(", ")}`,
  );
  check("no error note under it", !s.notes.some((n) => /couldn't load/.test(n)), s.notes.join(" | "));

  // ---- (c) it did not widen the pull to do it ------------------------------
  console.log("\n(c) the pull itself is untouched");
  check(
    "the backlog toggle is still off",
    s.backlogOn === false && backlogBefore === false,
    `before=${backlogBefore} after=${s.backlogOn}`,
  );
  check(
    "the header count did not move",
    s.count === countBefore,
    `before=${countBefore} after=${s.count}`,
  );

  // ---- (d) a filter must not fan out --------------------------------------
  // Measured UPSTREAM. The daemon caches this key, so a per-epic fetch storm is
  // invisible from the route — which is the same reason DRY-72's harness uses a
  // counting origin instead of proxy-tracker.mjs.
  console.log("\n(d) typing in the filter box does not fan out");
  await stubReset();
  const before = await stubState();
  await page.fill(".sidebar .searchbox input", "dormant");
  await sleep(1200);
  const after = await stubState();
  check(
    "no extra child lookups while filtering",
    after.lookup === before.lookup,
    `lookup ${before.lookup} -> ${after.lookup}`,
  );
  check(
    "no extra child queries while filtering",
    after.children === before.children,
    `children ${before.children} -> ${after.children}`,
  );
  await page.fill(".sidebar .searchbox input", "");
  await sleep(300);

  // ---- (e) Refresh reaches the expanded epic ------------------------------
  console.log("\n(e) Refresh re-pulls what is open");
  await stubReset();
  // Sampled ACROSS the refresh, not after it. A forced pull waits on the daemon,
  // and the fallback while it's in flight is the pull's own children — which for
  // this epic is the empty set that made it inert in the first place. So a
  // re-pull that drops what it has empties the epic for the length of a round
  // trip and fills it again: nothing is wrong, and the list blinks out anyway.
  // Reading once at the end cannot see that; it lands after the rows are back.
  let vanished = null;
  const watch = (async () => {
    for (let i = 0; i < 60; i++) {
      const seen = childrenOf(await snap(page));
      if (!OPEN_KIDS.every((k) => seen.includes(k))) {
        vanished ??= seen.join(", ") || "none";
      }
      await sleep(50);
    }
  })();
  await page.click(".sidebar button.refresh");
  const refetched = await waitFor(async () => (await stubState()).lookup >= 1);
  check(
    "Refresh re-pulled the expanded epic's children",
    refetched !== null,
    refetched === null ? `lookup=${(await stubState()).lookup}` : `${refetched}s`,
  );
  await watch;
  check(
    "and they never left the screen while it did",
    vanished === null,
    vanished === null ? "" : `saw: ${vanished}`,
  );
  s = await snap(page);
  check(
    "the children are on screen afterwards",
    OPEN_KIDS.every((k) => childrenOf(s).includes(k)),
    `children: ${childrenOf(s).join(", ")}`,
  );

  await browser.close();
  console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
