// DRY-77: a filter holds every repo group open, and the group header says so.
//
// A filter force-opens both collapse idioms (`isOpen`, `isEpicOpen`), so a click
// on a group header while one is active writes `expanded` and moves nothing
// until the filter lifts. DRY-75 explained that on the epic row's tooltip and
// left `.grp` with no `title` at all, so the more prominent header read as one
// that ignores its clicks.
//
// Why a browser: the claim is about an attribute on a rendered button and how
// it follows the filter. Nothing the daemon serves differs.
//
// What each section holds down:
//
//   (a) unfiltered, the header has a title naming the gesture. Fails against
//       the unpatched tree, where `title` is null.
//   (b) filtering, the title says the filter holds the group open — the
//       sentence the epic row already used.
//   (c) a click while filtering leaves the group open and the title unchanged:
//       the copy has to agree with the chevron (driven by `isOpen`), not with
//       the stored map.
//   (d) clearing the filter takes the qualifier back off. A title that kept
//       saying "the filter holds it open" with no filter would be its own bug.
//
// Rig: the DRY-55 sidebar rig (README.md, "The tracker sidebar") — a fixture
// daemon, proxy-tracker and vite. Run from `daemon/`, so tsx resolves:
//   (cd daemon && node --import tsx ../scripts/verify/group-title.mts)
import { chromium, type Page } from "playwright";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5375";
/** A fixture repo, and a filter term that matches some of its tickets. */
const REPO = process.env.REPO ?? "argosy";
const TERM = process.env.TERM_FILTER ?? "ARGY-";

let failures = 0;
function check(name: string, ok: boolean, extra = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? ` — ${extra}` : ""}`);
}

interface Head {
  title: string | null;
  open: boolean;
}

// Anonymous arrows inside the body only: a name-bound helper here becomes
// `__name(...)` under tsx and throws in the page (CLAUDE.md, DRY-80).
function head(page: Page): Promise<Head | null> {
  return page.evaluate((repo): Head | null => {
    const b = [...document.querySelectorAll(".sidebar .grp")].find(
      (g) => (g.querySelector(".grp-name")?.textContent ?? "").trim() === repo,
    );
    return b ? { title: b.getAttribute("title"), open: b.classList.contains("open") } : null;
  }, REPO);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("pageerror", (e) => check(`no page error (${e.message})`, false));

try {
  await page.goto(SHELL);
  await page.waitForSelector(".sidebar .grp", { timeout: 20_000 });

  console.log("\n(a) unfiltered");
  let h = await head(page);
  check(`the ${REPO} group is on the rail`, h !== null);
  check("its header has a title", !!h?.title, String(h?.title));
  check(
    "the title names the gesture and no filter",
    h?.title === `Expand or collapse ${REPO}`,
    String(h?.title),
  );

  console.log("\n(b) filtering");
  await page.fill(".sidebar .searchbox input", TERM);
  await page.waitForFunction(
    () => !!document.querySelector(".sidebar .clear"),
    undefined,
    { timeout: 5_000 },
  );
  h = await head(page);
  check("the group is forced open", h?.open === true);
  check(
    "the title says the filter holds it open",
    h?.title === `Expand or collapse ${REPO} — the filter holds it open for now`,
    String(h?.title),
  );

  console.log("\n(c) a click while filtering");
  await page.click(`.sidebar .grp:has(.grp-name:text-is("${REPO}"))`);
  h = await head(page);
  check("the group is still open", h?.open === true);
  check("the title still says why", /the filter holds it open for now$/.test(h?.title ?? ""), String(h?.title));

  console.log("\n(d) clearing the filter");
  await page.click(".sidebar .clear");
  await page.waitForFunction(
    () => !document.querySelector(".sidebar .clear"),
    undefined,
    { timeout: 5_000 },
  );
  h = await head(page);
  check("the qualifier is gone", h?.title === `Expand or collapse ${REPO}`, String(h?.title));
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nall ok");
process.exit(failures ? 1 : 0);
