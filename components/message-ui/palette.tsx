import { palettes, paletteVars } from "@/components/message-ui/tokens";
import { tapbackVars } from "@/components/message-ui/tapback";
import type { Platform } from "@/components/message-ui/platform";

function block(selector: string, vars: Record<string, string>) {
  return `${selector}{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";")}}`;
}

/**
 * Emits the measured palette as CSS custom properties for one platform, in both themes, scoped to
 * `[data-im-platform="ios"|"macos"]`. Dark values apply under a `.dark` ancestor (the same rule the
 * rest of the registry uses). Render it once per app shell; it is tiny and idempotent.
 *
 * It emits `tapbackVars` too. Those are the measured glass, dim and menu colours the long-press
 * overlay and both context menus read, and until now only the tapback lab spread them, so every
 * shell and every harness scenario silently fell back to the hardcoded light-iOS defaults baked into
 * the components. A dark long-press menu was drawing light-theme glass because of it.
 */
export function PaletteStyle({ platform }: { platform: Platform }) {
  const scope = `[data-im-platform="${platform}"]`;
  const css =
    block(scope, { ...paletteVars(palettes[platform].light), ...tapbackVars("light", platform) }) +
    block(`.dark ${scope}`, { ...paletteVars(palettes[platform].dark), ...tapbackVars("dark", platform) }) +
    // An explicitly light preview must remain light inside a dark documentation site. Keep the
    // same isolation boundary as the Tailwind dark variant in app/globals.css.
    block(`[data-preview-theme="light"] ${scope}`, { ...paletteVars(palettes[platform].light), ...tapbackVars("light", platform) }) +
    block(`[data-preview-theme="dark"] ${scope}`, { ...paletteVars(palettes[platform].dark), ...tapbackVars("dark", platform) });
  return <style data-slot="palette" data-platform={platform}>{css}</style>;
}
