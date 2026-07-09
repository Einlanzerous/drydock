// Shared markdown renderer (DRY-35): the terminal-opened doc viewer and the
// ticket description body render through the same pipeline. Everything that
// reaches this is untrusted (agent-written files, tracker descriptions), so
// the marked output ALWAYS passes through DOMPurify before v-html.
import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({
  gfm: true,
  breaks: false,
});

// External links leave the app deliberately: force new tab + no opener. Hook
// runs inside sanitization so it also covers links a doc tries to sneak in.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && /^https?:/i.test(node.getAttribute("href") ?? "")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false });
  return DOMPurify.sanitize(html, {
    // Markdown needs nothing exotic; forbid the classic vectors outright.
    FORBID_TAGS: ["style", "form", "input", "iframe", "object", "embed"],
    FORBID_ATTR: ["onerror", "onload", "style"],
  });
}
