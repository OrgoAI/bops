/**
 * An app's preview page (desktop/preview-frames.cjs): S, D and Esc pressed in the page itself, which has the keys
 * once it's clicked (it's a process of its own), go up to its webview in the window (sendToHost) as the key's name
 * and nothing more, so Select and Draw (components/app/preview-tab.tsx) answer them as they do in the preview's bar.
 * It runs before the page's scripts, in a world of their own: the page can't reach it, and it hears only real
 * presses (isTrusted). S and D never while something's being typed (a field, a text box, a menu, anything
 * editable), never with Cmd, Ctrl or Alt, never held down, and never when the page's own listeners took the key
 * (defaultPrevented, read once they've all run), so a site's own S wins. Esc always. The page gets nothing.
 */
const { ipcRenderer } = require("electron");

/** What takes typing: a field, a text box, a menu, or anything editable. */
const typing = (el) => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable === true);

/** What has the focus, inside open shadow roots too. */
function focused() {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

window.addEventListener(
  "keydown",
  (e) => {
    if (!e.isTrusted) return;
    if (e.key === "Escape") return ipcRenderer.sendToHost("bops-preview-key", "escape");
    const k = typeof e.key === "string" ? e.key.toLowerCase() : "";
    if ((k !== "s" && k !== "d") || e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.isComposing) return;
    if (typing(e.composedPath()[0]) || typing(focused())) return;
    // (Once the page's own listeners have all had it.)
    setTimeout(() => {
      if (!e.defaultPrevented) ipcRenderer.sendToHost("bops-preview-key", k);
    }, 0);
  },
  true,
);
