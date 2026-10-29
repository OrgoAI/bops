import re, sys
TOK = {"0A0A0A","1C1C1B","2A2A28","3A3A38","3A3A3A","6B6B6B","8A8A88","9A9A98","B0B0AD","B5B5B2","C9C9C6","D6D6D3","D9D9D6","E2E2DF","E6E6E3","EAEAE7","ECECEA","F0F0EE","EEEEEC","F2F2F0","F4F4F2","F6F6F4","F7F7F6","F9F9F8","FCFCFB","FBFFE0","FDFFE6","FBFFD9","FDFFF6","E6F57A"}
UTIL = r"(text|bg|border(?:-[trblxy])?|ring|outline|fill|stroke|from|via|to|divide|decoration|placeholder|caret|accent)"
for f in sys.argv[1:]:
  s = open(f).read(); o = s
  # In a regex: bg-\[#F6F6F4\] -> bg-\[color:var\(--c-f6f6f4\)\]
  s = re.sub(UTIL + r"-\\\[#([0-9A-Fa-f]{6})\\\]", lambda m: f"{m.group(1)}-\\[color:var\\(--c-{m.group(2).lower()}\\)\\]" if m.group(2).upper() in TOK else m.group(0), s)
  # In a string: bg-[#C9C9C6] -> bg-[color:var(--c-c9c9c6)]
  s = re.sub(UTIL + r"-\[#([0-9A-Fa-f]{6})\]", lambda m: f"{m.group(1)}-[color:var(--c-{m.group(2).lower()})]" if m.group(2).upper() in TOK else m.group(0), s)
  if s != o: open(f, "w").write(s); print("changed", f)
