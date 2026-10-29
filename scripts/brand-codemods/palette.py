import re, sys, glob, json
# Bops' neutrals -> a token each (app/globals.css: Bops' values in :root, a brand's under [data-brand]).
TOKENS = {
  "0A0A0A": "n-ink", "1C1C1B": "n-ink2", "2A2A28": "n-ink3", "3A3A38": "n-text", "3A3A3A": "n-text", "6B6B6B": "n-muted", "8A8A88": "n-muted2",
  "9A9A98": "n-faint", "B0B0AD": "n-faint2", "B5B5B2": "n-faint2", "C9C9C6": "n-line5", "D6D6D3": "n-line5", "D9D9D6": "n-line5",
  "E2E2DF": "n-line4", "E6E6E3": "n-line3", "EAEAE7": "n-line2", "ECECEA": "n-line", "F0F0EE": "n-hair",
  "EEEEEC": "n-fill3", "F2F2F0": "n-fill2", "F4F4F2": "n-fill", "F6F6F4": "n-wash", "F7F7F6": "n-wash", "F9F9F8": "n-side", "FCFCFB": "n-lift",
  "FBFFE0": "n-hl-wash", "FDFFE6": "n-hl-wash", "FBFFD9": "n-hl-wash", "FDFFF6": "n-hl-wash", "E6F57A": "n-hl-line",
}
COLOR_UTIL = re.compile(r"(?:^|[\s:\"'`{(])((?:[a-z-]+:)*)(text|bg|border(?:-[trblxy])?|ring|ring-offset|outline|fill|stroke|from|via|to|divide|decoration|placeholder|caret|accent)-\[#([0-9A-Fa-f]{6})\]")
BRACKET = re.compile(r"-\[[^\]\s\"'`]*#[0-9A-Fa-f]{6}[^\]\s\"'`]*\]")
used = {}
def tok(h):
  if h.upper() not in TOKENS: return None
  t = "c-" + h.lower()
  used[h.upper()] = t
  return t
changed = 0
for f in sys.argv[1:]:
  s = open(f).read(); o = s
  # A color utility whose whole value is a neutral: the token, with a type hint (text-[color:var(--n-muted)]).
  def one(m):
    t = tok(m.group(3))
    if not t: return m.group(0)
    lead = m.group(0)[: m.start(1) - m.start(0)]
    return f"{lead}{m.group(1)}{m.group(2)}-[color:var(--{t})]"
  s = COLOR_UTIL.sub(one, s)
  # Neutrals inside a longer arbitrary value (shadow-[0_0_0_1px_#E6E6E3]): the token in place.
  def many(m):
    return re.sub(r"#([0-9A-Fa-f]{6})", lambda h: f"var(--{tok(h.group(1))})" if tok(h.group(1)) else h.group(0), m.group(0))
  s = BRACKET.sub(many, s)
  if s != o:
    open(f, "w").write(s); changed += 1
print("files", changed); print(json.dumps(used, indent=0))
