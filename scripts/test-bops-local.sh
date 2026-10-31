#!/usr/bin/env bash
# vm/bin/bops-local in a real shell: one port a site, the same every time and never another Local's (running or
# stopped), assigned under a lock (two starts at once get two ports); a port given, auto, and one another Local
# has (port-taken); something else on its port fails it as port-held (never a silent move), while a dev server
# left over from the app's own folder is stopped first; a start refused (port-taken, port-held, no-port) leaves a
# running Local running; a dev server on a port of its own said as a mismatch, never taken; two Locals with one
# port from before settled (the one running on it, else the app's own site, else the oldest, keeps it); sign in
# at its own address; a Preview's variables made local on that address; its own variables on top; an install
# when package.json or its lockfile changed since the last one; mark good and fix; open on a screen's Chrome (its
# DevTools port, 9200 + the display); the frozen BOPS_LOCAL line and the BOPS_LOCAL_MORE line after it (dev,
# good, fixes, auth, mismatch); keys it doesn't know kept; its version; stop; no port left; and forget, an app's Locals
# gone with it, its ports free again; a bot's copy of an app (<app>.<copy>): Locals of its own on ports of their own,
# its own sign in address and variables, status and forget of a copy, of the app's own folder, and of the app with
# every copy; a copy's node_modules linked from another folder's with the same package.json and lockfile, never
# installed twice, never written into. Everything under a temp
# dir (BOPS_LOCAL_HOME, BOPS_APPS_DIR, BOPS_ORGO_APPS_DIR); nothing of Bops' own is touched.
#
# On Linux (a Bops computer) as it is. On a Mac, with stand ins for what Linux has and a Mac doesn't (setsid,
# flock, ss and pgrep -s from lsof and ps, base64 -w0), in a temp dir under $TMPDIR.
#
# Usage: bash scripts/test-bops-local.sh [path/to/bops-local]
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BIN=${1:-$HERE/../vm/bin/bops-local}
T=$(mktemp -d "${TMPDIR:-/tmp}/bops-local-test.XXXXXX")
# (Its real path: a process's working folder is said that way.)
T=$(cd "$T" && pwd -P)
export BOPS_LOCAL_HOME=$T/local BOPS_APPS_DIR=$T/apps BOPS_ORGO_APPS_DIR=$T/orgo
fails=0
ok() { echo "ok - $1"; }
no() { echo "not ok - $1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else no "$1"; fi; }

if [ "$(uname -s)" = Darwin ]; then
  mkdir -p "$T/shim"
  cat > "$T/shim/setsid" << 'EOF'
#!/bin/bash
exec python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' "$@"
EOF
  cat > "$T/shim/flock" << 'EOF'
#!/bin/bash
# flock [-w seconds] <fd>: the lock taken on that open file (its holder keeps it after this exits).
w=30
[ "$1" = -w ] && { w=$2; shift 2; }
exec python3 -c '
import fcntl, sys, time
fd, end = int(sys.argv[1]), time.time() + float(sys.argv[2])
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        sys.exit(0)
    except BlockingIOError:
        if time.time() > end:
            sys.exit(1)
        time.sleep(0.05)
' "$1" "$w"
EOF
  cat > "$T/shim/ss" << 'EOF'
#!/bin/bash
# ss -Hltn and ss -Hltnp, from lsof.
lsof -nP -iTCP -sTCP:LISTEN -F pn 2> /dev/null | awk '/^p/ { pid = substr($0, 2) } /^n/ { printf "LISTEN 0 128 %s 0.0.0.0:* users:((\"x\",pid=%s,fd=3))\n", substr($0, 2), pid }'
EOF
  cat > "$T/shim/pgrep" << 'EOF'
#!/bin/bash
# pgrep -s <session>: a Mac has no sessions here, so its process group (setsid made it one).
if [ "$1" = -s ]; then ps -axo pid=,pgid= | awk -v g="$2" '$2 == g { print $1 }'; else exec /usr/bin/pgrep "$@"; fi
EOF
  cat > "$T/shim/base64" << 'EOF'
#!/bin/bash
a=()
for x in "$@"; do [ "$x" = -w0 ] || a+=("$x"); done
exec /usr/bin/base64 "${a[@]}"
EOF
  chmod +x "$T/shim/"*
  export PATH="$T/shim:$PATH"
fi

b64() { printf %s "$1" | base64 -w0; }
word() { echo "$1" | grep -E "^BOPS_LOCAL $2 " | tail -n 1 | awk -v n="$3" '{print $n}'; }
more() { echo "$1" | grep -E "^BOPS_LOCAL_MORE $2( |$)" | tail -n 1; }
dev() { more "$1" "$2" | grep -oE " dev=[0-9]+" | cut -d= -f2; }
conf() { grep -E "^$2=" "$BOPS_LOCAL_HOME/$1.conf" | cut -d= -f2-; }
started=()
start() {
  started+=("$1--$2")
  "$BIN" start "$@"
}
cleanup() {
  for k in "${started[@]}"; do "$BIN" stop "${k%%--*}" "${k##*--}" > /dev/null 2>&1; done
  for p in ${HOLD:-} ${STALE:-} ${CDP:-}; do kill "$p" 2> /dev/null; done
  rm -rf "$T"
}
trap cleanup EXIT
# A listener on a port, from folder `dir`, until killed: its pid in $!.
hold() { (cd "$2" && exec python3 -c 'import socket,sys,time;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(("0.0.0.0",int(sys.argv[1])));s.listen();time.sleep(120)' "$1") & }

for a in shop keeps envs pkg blog old; do mkdir -p "$BOPS_APPS_DIR/$a"; done
mkdir -p "$BOPS_ORGO_APPS_DIR/k7p2qxm4wr3d/current"
echo hi > "$BOPS_APPS_DIR/shop/index.html"
SERVE='python3 -m http.server "$PORT" --bind 0.0.0.0'
# v0.0.34's parser's line (lib/server/hosted-apps.ts localsFrom, \S as [^[:space:]]), anchored at both ends: seven
# words after BOPS_LOCAL, never an eighth. frozen: every BOPS_LOCAL line of an answer is one (and there's one).
OLD='^BOPS_LOCAL ([^[:space:]]+)--([^[:space:]]+) (running|starting|failed|stopped) ([^[:space:]]+) ([^[:space:]]+) ([^[:space:]]+) ([^[:space:]]+) ([^[:space:]]+)$'
frozen() { local l; l=$(echo "$1" | grep -E "^BOPS_LOCAL "); [ -n "$l" ] && [ "$(echo "$l" | grep -cvE "$OLD")" = 0 ]; }

check "it says its version" 'grep -qx "BOPS_LOCAL_VERSION=[0-9][0-9]*" "$BIN"'

# 1. A first start: the lowest free port, 3000. Its fourth word and its second line's dev are that port.
out=$(start shop shop "$(b64 "$SERVE")" - - - -)
check "a first start gets 3000" '[ "$(word "$out" shop--shop 4)" = 3000 ] && [ "$(word "$out" shop--shop 3)" = running ]'
check "its second line's dev is its port too" '[ "$(dev "$out" shop--shop)" = 3000 ]'
check "its BOPS_LOCAL line is as v0.0.34 reads it: no eighth word" 'frozen "$out"'
check "a BOPS_LOCAL_MORE line follows it: a plain site doesn't sign in" '[ "$(more "$out" shop--shop)" = "BOPS_LOCAL_MORE shop--shop dev=3000 auth=0" ] && echo "$out" | grep -A1 "^BOPS_LOCAL shop--shop" | tail -n 1 | grep -q "^BOPS_LOCAL_MORE shop--shop"'
"$BIN" stop shop shop > /dev/null

# 2. Another site, while the first is stopped: never its port. Each keeps its own, restarted or not.
out=$(start shop admin "$(b64 "$SERVE")" - - - -)
check "another site gets 3001 though the first is stopped" '[ "$(word "$out" shop--admin 4)" = 3001 ] && [ "$(dev "$out" shop--admin)" = 3001 ]'
out=$(start shop shop - - - - -)
check "the first gets 3000 again" '[ "$(word "$out" shop--shop 4)" = 3000 ]'
out=$(start shop admin - - - - -)
check "a restart keeps its port" '[ "$(word "$out" shop--admin 4)" = 3001 ]'
out=$("$BIN" status shop)
check "status says both, each with its second line" '[ "$(word "$out" shop--shop 4)" = 3000 ] && [ "$(word "$out" shop--admin 4)" = 3001 ] && [ "$(echo "$out" | grep -c "^BOPS_LOCAL_MORE ")" = 2 ] && echo "$out" | grep -qx "BOPS_LOCAL_DONE=1"'
check "a stopped one's line and a running one's, each as v0.0.34 reads it" 'frozen "$out" && [ "$(echo "$out" | grep -c "^BOPS_LOCAL ")" = 2 ]'
"$BIN" stop shop admin > /dev/null

# 3. A port given that another Local has: port-taken, said whose. auto: the lowest free.
out=$(start blog blog "$(b64 "$SERVE")" - - - 3000)
check "a port another Local has is refused (port-taken)" 'echo "$out" | grep -qx "BOPS_LOCAL_FAIL=port-taken" && echo "$out" | grep -qx "BOPS_LOCAL_HELD=3000 shop--shop"'
out=$(start blog blog "$(b64 "$SERVE")" - - - 3050)
check "a port of its own, given" '[ "$(word "$out" blog--blog 4)" = 3050 ] && [ "$(conf blog--blog DEVPORT)" = 3050 ]'
out=$(start blog blog - - - - auto)
check "auto: the lowest free (3002: 3000 and 3001 are the shop's)" '[ "$(word "$out" blog--blog 4)" = 3002 ]'
"$BIN" stop blog blog > /dev/null

# 3b. A start refused leaves a running Local running, on its port: one another Local has (port-taken), one
# something else holds (port-held). auto keeps the one it runs on when that's the lowest free.
pid=$(conf shop--shop PID)
up() { kill -0 "$pid" 2> /dev/null && [ "$(conf shop--shop STOPPED)" = 0 ] && [ "$(conf shop--shop DEVPORT)" = 3000 ] && [ "$(word "$("$BIN" status shop)" shop--shop 3)" = running ]; }
check "it runs on 3000" 'up'
out=$(start shop shop - - - - 3001)
check "a port another Local has: port-taken, and it runs on" 'echo "$out" | grep -qx "BOPS_LOCAL_FAIL=port-taken" && up'
hold 3071 "$T"
HOLD=$!
sleep 0.5
out=$(start shop shop - - - - 3071)
check "a port something else holds: port-held, and it runs on" 'echo "$out" | grep -qx "BOPS_LOCAL_FAIL=port-held" && echo "$out" | grep -qx "BOPS_LOCAL_HELD=3071" && up'
check "and what holds it is left alone" 'kill -0 "$HOLD" 2> /dev/null'
kill "$HOLD" 2> /dev/null
HOLD=
out=$(start shop shop - - - - auto)
check "auto while it runs on the lowest free: that one again" '[ "$(word "$out" shop--shop 4)" = 3000 ] && [ "$(word "$out" shop--shop 3)" = running ]'
"$BIN" stop shop shop > /dev/null

# 4. Its port held by something else: port-held, and it doesn't move. One left over from the app's own folder is stopped.
hold 3000 "$T"
HOLD=$!
sleep 0.5
out=$(start shop shop - - - - -)
check "something else on its port: port-held, never moved" 'echo "$out" | grep -qx "BOPS_LOCAL_FAIL=port-held" && echo "$out" | grep -qx "BOPS_LOCAL_HELD=3000" && [ "$(conf shop--shop DEVPORT)" = 3000 ]'
check "what holds it is left alone" 'kill -0 "$HOLD" 2> /dev/null'
kill "$HOLD" 2> /dev/null
HOLD=
hold 3000 "$BOPS_APPS_DIR/shop"
STALE=$!
sleep 0.5
out=$(start shop shop - - - - -)
check "a dev server left over from its own folder is stopped, and it starts on its port" '[ "$(word "$out" shop--shop 4)" = 3000 ] && [ "$(word "$out" shop--shop 3)" = running ]'
check "the leftover is gone" 'sleep 0.3; ! kill -0 "$STALE" 2> /dev/null'
STALE=
"$BIN" stop shop shop > /dev/null

# 5. A command that always listens on 5173: a mismatch, said, never its port.
out=$(start keeps keeps "$(b64 'python3 -m http.server 5173 --bind 0.0.0.0')" - - - -)
sleep 1
out=$("$BIN" status keeps)
check "a dev server on 5173 is a mismatch: its port stays its own" '[ "$(word "$out" keeps--keeps 4)" = 3003 ] && [ "$(word "$out" keeps--keeps 3)" = starting ] && more "$out" keeps--keeps | grep -q " mismatch=5173"'
check "a starting one's line as v0.0.34 reads it" 'frozen "$out"'
check "and it's never written as its port" '[ "$(conf keeps--keeps PORT)" = 3003 ]'
pid=$(conf keeps--keeps PID)
"$BIN" stop keeps keeps > /dev/null
sleep 0.5
check "stop kills its process group" '! kill -0 "$pid" 2> /dev/null'

# 5b. One that stops by itself: failed, with the last 6 lines of its log that aren't empty as its last words.
out=$(start keeps keeps "$(b64 'for i in 1 2 3 4 5 6 7 8; do echo "line $i"; echo; done; exit 1')" - - - -)
sleep 0.5
out=$("$BIN" status keeps)
words=$(word "$out" keeps--keeps 7 | base64 -d 2> /dev/null)
check "stopped by itself: failed" '[ "$(word "$out" keeps--keeps 3)" = failed ]'
check "a failed one's line as v0.0.34 reads it" 'frozen "$out"'
check "its last words: the last 6 lines that aren't empty" '[ "$words" = "$(printf "line %s\n" 3 4 5 6 7 8 | sed "\$ s/\$//")" ]'
"$BIN" stop keeps keeps > /dev/null

# 6. Sign in at its own address; a Preview variable naming its link made local there; its own variables on top.
cat > "$BOPS_ORGO_APPS_DIR/k7p2qxm4wr3d/current/app.env" << 'EOF'
SITE_URL=https://k7p2qxm4wr3d.orgo.dev/app
FROM_PREVIEW=yes
MINE=preview
EOF
printf %s "$(b64 '{"MINE":"local"}')" | "$BIN" env envs envs > /dev/null
DUMP='env | grep -E "^(AUTH_URL|NEXTAUTH_URL|BETTER_AUTH_URL|SITE_URL|FROM_PREVIEW|MINE|AUTH_TRUST_HOST|PORT)=" | sort > "$BOPS_LOCAL_HOME/../env.txt"; exec python3 -m http.server "$PORT" --bind 0.0.0.0'
out=$(start envs envs "$(b64 "$DUMP")" - k7p2qxm4wr3d "$(b64 https://k7p2qxm4wr3d.orgo.dev)" -)
P=$(word "$out" envs--envs 4)
sleep 1
E=$(cat "$T/env.txt" 2> /dev/null)
check "its port is the next free (3004)" '[ "$P" = 3004 ]'
check "PORT is its port" 'echo "$E" | grep -qx "PORT=$P"'
check "AUTH_URL is its own address" 'echo "$E" | grep -qx "AUTH_URL=http://localhost:$P"'
check "NEXTAUTH_URL and BETTER_AUTH_URL too" 'echo "$E" | grep -qx "NEXTAUTH_URL=http://localhost:$P" && echo "$E" | grep -qx "BETTER_AUTH_URL=http://localhost:$P"'
check "AUTH_TRUST_HOST is true" 'echo "$E" | grep -qx "AUTH_TRUST_HOST=true"'
check "a Preview variable naming its link is made its own address" 'echo "$E" | grep -qx "SITE_URL=http://localhost:$P/app"'
check "the Preview's other variables come along" 'echo "$E" | grep -qx "FROM_PREVIEW=yes"'
check "its own variables win" 'echo "$E" | grep -qx "MINE=local"'
"$BIN" stop envs envs > /dev/null

# 7. An install when node_modules is missing or package.json or its lockfile changed since; none otherwise. auth.
mkdir -p "$T/npm"
cat > "$T/npm/npm" << EOF
#!/bin/bash
echo "\$*" >> "$T/npm.log"
mkdir -p node_modules
EOF
chmod +x "$T/npm/npm"
echo '{"name":"pkg","dependencies":{"next":"16.0.0"}}' > "$BOPS_APPS_DIR/pkg/package.json"
installs() { grep -c '^install' "$T/npm.log" 2> /dev/null || echo 0; }
pstart() { PATH="$T/npm:$PATH" start pkg pkg "$(b64 "$SERVE")" - - - - > /dev/null; sleep 1; }
pstart
check "a first start installs" '[ "$(installs)" = 1 ]'
check "what it installed from is kept" '[ -n "$(conf pkg--pkg PKGHASH)" ]'
pstart
check "nothing changed: no install" '[ "$(installs)" = 1 ]'
echo '{}' > "$BOPS_APPS_DIR/pkg/package-lock.json"
pstart
check "its lockfile changed: an install" '[ "$(installs)" = 2 ]'
echo '{"name":"pkg","dependencies":{"next":"16.0.0","next-auth":"5.0.0"}}' > "$BOPS_APPS_DIR/pkg/package.json"
pstart
check "package.json changed: an install" '[ "$(installs)" = 3 ]'
out=$("$BIN" status pkg)
check "next-auth in package.json: auth=1" 'more "$out" pkg--pkg | grep -q " auth=1"'
for dep in '"@auth/core":"0.1.0"' '"better-auth":"1.0.0"'; do
  echo "{\"devDependencies\":{$dep}}" > "$BOPS_APPS_DIR/blog/package.json"
  out=$("$BIN" status blog)
  check "$dep: auth=1" 'more "$out" blog--blog | grep -q " auth=1"'
done
"$BIN" stop pkg pkg > /dev/null

# 8. mark: fix counts Fix it presses; good keeps the changeset and when, and starts the count again.
"$BIN" mark pkg pkg fix > /dev/null
out=$("$BIN" mark pkg pkg fix)
check "two fixes" 'more "$out" pkg--pkg | grep -q " fixes=2" && echo "$out" | grep -qx "BOPS_LOCAL_MARKED=1"'
ID=$(printf 'a%.0s' $(seq 1 64))
out=$("$BIN" mark pkg pkg good "$ID")
check "good: the changeset and when; fixes back to 0" 'more "$out" pkg--pkg | grep -qE " good=$ID:[0-9]{9,} fixes=0 "'
check "a changeset that isn't one is refused" '[ "$("$BIN" mark pkg pkg good nothex)" = BOPS_LOCAL_FAIL=bad-changeset ]'
check "a Local never started can't be marked" '[ "$("$BIN" mark nope nope fix)" = BOPS_LOCAL_FAIL=not-started ]'

# 9. Keys it doesn't know (a newer bops-local's) are kept as they are.
echo "FUTURE_THING=x=y z" >> "$BOPS_LOCAL_HOME/pkg--pkg.conf"
"$BIN" mark pkg pkg fix > /dev/null
check "a key it doesn't know is kept" 'grep -qx "FUTURE_THING=x=y z" "$BOPS_LOCAL_HOME/pkg--pkg.conf"'
check "what it knows is written too" '[ "$(conf pkg--pkg FIXES)" = 1 ]'

# 10. Open on a screen: a new tab in that screen's Chrome, at its DevTools port (9200 + the display; 777 here, a
# display no Bops screen has, so a real screen's Chrome on this computer is never in the way).
python3 -c '
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_PUT(self):
        open(sys.argv[2], "a").write(self.path + "\n")
        self.send_response(200); self.end_headers(); self.wfile.write(b"{}")
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
' 9977 "$T/cdp.log" &
CDP=$!
sleep 0.5
start shop shop - - - - - > /dev/null
out=$("$BIN" open shop shop 777)
check "open on display 777: a tab at 9977, at its address" 'echo "$out" | grep -qx "BOPS_LOCAL_OPENED=1" && grep -qx "/json/new?http://localhost:3000/" "$T/cdp.log"'
check "a display that isn't one is refused" '[ "$("$BIN" open shop shop x9)" = BOPS_LOCAL_FAIL=bad-screen ]'
"$BIN" stop shop shop > /dev/null

# 11. Two Locals with one port from before: the one running on it keeps it; else the app's own site, the other
# getting the lowest free; else the oldest.
for k in old--old old--side; do printf 'PORT=3060\nPID=\nCMD_B64=%s\nSINCE=1700000000\nSTOPPED=1\nENVFROM=\nDEVPORT=3060\nENVURL_B64=\n' "$(b64 "$SERVE")" > "$BOPS_LOCAL_HOME/$k.conf"; done
printf 'MADE=1600000000\n' >> "$BOPS_LOCAL_HOME/old--side.conf"
out=$("$BIN" status old)
check "the app's own site keeps its port, though the other was made first" '[ "$(word "$out" old--old 4)" = 3060 ] && [ "$(dev "$out" old--side)" = 3006 ] && [ "$(conf old--side PORT)" = 3006 ]'
for k in old--a old--b; do printf 'PORT=3061\nDEVPORT=3061\nSTOPPED=1\nSINCE=%s\n' "$([ $k = old--a ] && echo 1700000500 || echo 1700000100)" > "$BOPS_LOCAL_HOME/$k.conf"; done
out=$("$BIN" status old)
check "else the one started first keeps it" '[ "$(word "$out" old--b 4)" = 3061 ] && [ "$(word "$out" old--a 4)" = 3007 ]'
rm -f "$BOPS_LOCAL_HOME"/old--*
start old side "$(b64 "$SERVE")" - - - 3062 > /dev/null
printf 'PORT=3062\nPID=\nCMD_B64=%s\nSINCE=1700000000\nSTOPPED=1\nENVFROM=\nDEVPORT=3062\nENVURL_B64=\nMADE=1500000000\n' "$(b64 "$SERVE")" > "$BOPS_LOCAL_HOME/old--old.conf"
out=$("$BIN" status old)
check "the one running on it keeps it (never pushed aside), though the other is the app's own site and made first" '[ "$(word "$out" old--side 3)" = running ] && [ "$(word "$out" old--side 4)" = 3062 ] && [ "$(conf old--side DEVPORT)" = 3062 ] && [ "$(dev "$out" old--old)" = 3006 ]'
"$BIN" stop old side > /dev/null
rm -f "$BOPS_LOCAL_HOME"/old--*

# 12. Two first starts at once: two ports.
mkdir -p "$BOPS_APPS_DIR/twin"
(start twin one "$(b64 "$SERVE")" - - - - > "$T/one.out") &
w1=$!
(start twin two "$(b64 "$SERVE")" - - - - > "$T/two.out") &
w2=$!
wait "$w1" "$w2"
started+=(twin--one twin--two)
p1=$(word "$(cat "$T/one.out")" twin--one 4)
p2=$(word "$(cat "$T/two.out")" twin--two 4)
check "two starts at once get two ports ($p1, $p2)" '[ -n "$p1" ] && [ -n "$p2" ] && [ "$p1" != "$p2" ]'
"$BIN" stop twin one > /dev/null
"$BIN" stop twin two > /dev/null

# 13. No port from 3000 to 3099: no-port (a stand in ss says they're all taken).
mkdir -p "$T/bin" "$BOPS_APPS_DIR/full"
cat > "$T/bin/ss" << 'EOF'
#!/bin/bash
for p in $(seq 3000 3099); do echo "LISTEN 0 128 0.0.0.0:$p 0.0.0.0:*"; done
EOF
chmod +x "$T/bin/ss"
out=$(PATH="$T/bin:$PATH" "$BIN" start full full "$(b64 "$SERVE")" - - - -)
check "no-port when 3000 to 3099 are taken" 'echo "$out" | grep -qx "BOPS_LOCAL_FAIL=no-port"'
# One running on a port of its own (4050) asked for auto then: no-port, and it runs on.
out=$(start full full "$(b64 "$SERVE")" - - - 4050)
pid=$(conf full--full PID)
out=$(PATH="$T/bin:$PATH" "$BIN" start full full - - - - auto)
check "no-port leaves a running Local running" 'echo "$out" | grep -qx "BOPS_LOCAL_FAIL=no-port" && kill -0 "$pid" 2> /dev/null && [ "$(conf full--full STOPPED)" = 0 ] && [ "$(word "$("$BIN" status full)" full--full 3)" = running ]'
"$BIN" stop full full > /dev/null

# 14. forget: its app removed, every Local of it stopped (running or not) and its files gone (its own variables
# too), so its port is free for the next app's first site; another app's are left as they are.
mkdir -p "$BOPS_APPS_DIR/gone" "$BOPS_APPS_DIR/next"
start gone gone "$(b64 "$SERVE")" - - - - > /dev/null
start gone admin "$(b64 "$SERVE")" - - - - > /dev/null
"$BIN" stop gone admin > /dev/null
printf %s "$(b64 '{"GONE_SECRET":"x"}')" | "$BIN" env gone gone > /dev/null
gpid=$(conf gone--gone PID)
gport=$(conf gone--gone DEVPORT)
others=$(ls "$BOPS_LOCAL_HOME" | grep -v '^gone--' | sort)
out=$("$BIN" forget gone)
check "forget says how many it forgot" 'echo "$out" | grep -qx "BOPS_LOCAL_FORGOT=2"'
check "the one running is stopped" 'sleep 0.3; ! kill -0 "$gpid" 2> /dev/null'
check "their files are gone, its own variables too" '! ls "$BOPS_LOCAL_HOME" | grep -q "^gone--"'
check "status says none of it" '[ "$("$BIN" status gone)" = BOPS_LOCAL_DONE=1 ]'
check "another app's are left as they are" '[ "$(ls "$BOPS_LOCAL_HOME" | grep -v "^gone--" | sort)" = "$others" ]'
out=$(start next next "$(b64 "$SERVE")" - - - -)
check "the next app's first site gets its port ($gport)" '[ "$(word "$out" next--next 4)" = "$gport" ]'
"$BIN" stop next next > /dev/null
check "forget of an app with none forgets nothing" '[ "$("$BIN" forget nothing)" = BOPS_LOCAL_FORGOT=0 ]'
check "a name that can't be an app's is refused" '[ "$("$BIN" forget ../x)" = BOPS_LOCAL_FAIL=bad-name ]'

# 15. A bot's copy of an app (<app>.<copy>, its own folder): its Locals keyed <app>.<copy>--<site>, each on a port of
# its own, never the app's own folder's or another copy's; the app's own folder keeps its key and port; sign in at the
# copy's own address; the app's own variables for that site under the copy's own; status of the app says its own and
# every copy's, of a copy its own alone; a copy never stops what runs from another folder; forget of one copy, of the
# app's own folder only, and of the app, every copy with it. A copy's name is checked as an app's is.
mkdir -p "$BOPS_APPS_DIR/shop.sam" "$BOPS_APPS_DIR/shop.ivy-2"
home=$(start shop shop - - - - -)
hp=$(word "$home" shop--shop 4)
printf %s "$(b64 '{"SHARED":"home","MINE":"home"}')" | "$BIN" env shop shop > /dev/null
printf %s "$(b64 '{"MINE":"copy"}')" | "$BIN" env shop.sam shop > /dev/null
CDUMP='env | grep -E "^(AUTH_URL|NEXTAUTH_URL|SHARED|MINE|PORT)=" | sort > "$BOPS_LOCAL_HOME/../copy-env.txt"; exec python3 -m http.server "$PORT" --bind 0.0.0.0'
out=$(start shop.sam shop "$(b64 "$CDUMP")" - - - -)
cp1=$(word "$out" shop.sam--shop 4)
check "a copy's Local is keyed <app>.<copy>--<site> and runs" '[ "$(word "$out" shop.sam--shop 3)" = running ] && [ -f "$BOPS_LOCAL_HOME/shop.sam--shop.conf" ]'
check "on a port of its own ($cp1), not the app's own folder's ($hp)" '[ -n "$cp1" ] && [ "$cp1" != "$hp" ] && [ "$(dev "$out" shop.sam--shop)" = "$cp1" ]'
check "its line is the frozen one, its app word the copy's (an older Bops passes it over)" 'frozen "$(echo "$out" | grep -E "^BOPS_LOCAL shop.sam--shop ")" && more "$out" shop.sam--shop | grep -q "^BOPS_LOCAL_MORE shop.sam--shop "'
check "the app's own folder keeps its key, its port and runs on" '[ "$(word "$("$BIN" status shop)" shop--shop 4)" = "$hp" ] && [ "$(word "$("$BIN" status shop)" shop--shop 3)" = running ]'
sleep 1
E=$(cat "$T/copy-env.txt" 2> /dev/null)
check "sign in at the copy's own address" 'echo "$E" | grep -qx "AUTH_URL=http://localhost:$cp1" && echo "$E" | grep -qx "NEXTAUTH_URL=http://localhost:$cp1" && echo "$E" | grep -qx "PORT=$cp1"'
check "the app's own variables for that site, the copy's own on top" 'echo "$E" | grep -qx "SHARED=home" && echo "$E" | grep -qx "MINE=copy"'
out=$(start shop.ivy-2 shop "$(b64 "$SERVE")" - - - -)
cp2=$(word "$out" shop.ivy-2--shop 4)
check "a second copy gets another port ($cp2)" '[ -n "$cp2" ] && [ "$cp2" != "$hp" ] && [ "$cp2" != "$cp1" ]'
out=$("$BIN" status shop)
check "status of the app: its own folder's and every copy's" '[ "$(word "$out" shop--shop 4)" = "$hp" ] && [ "$(word "$out" shop.sam--shop 4)" = "$cp1" ] && [ "$(word "$out" shop.ivy-2--shop 4)" = "$cp2" ] && echo "$out" | grep -qx "BOPS_LOCAL_DONE=1"'
out=$("$BIN" status shop.sam)
check "status of a copy: its own alone" '[ "$(echo "$out" | grep -c "^BOPS_LOCAL ")" = 1 ] && [ "$(word "$out" shop.sam--shop 4)" = "$cp1" ]'
echo '{"dependencies":{"next-auth":"5.0.0"}}' > "$BOPS_APPS_DIR/shop.sam/package.json"
out=$("$BIN" status shop)
check "a copy reads its own folder (auth from its package.json)" 'more "$out" shop.sam--shop | grep -q " auth=1" && more "$out" shop--shop | grep -q " auth=0"'
rm -f "$BOPS_APPS_DIR/shop.sam/package.json"
for bad in shop.Sam shop..x shop.a.b .shop shop. "shop.a b"; do
  check "a copy named \"$bad\" is refused" '[ "$("$BIN" start "$bad" shop - - - - - | tail -n 1)" = BOPS_LOCAL_FAIL=bad-name ]'
done
hold 3091 "$BOPS_APPS_DIR/shop"
HOLD=$!
sleep 0.5
out=$(start shop.sam shop - - - - 3091)
check "a port held from the app's own folder: port-held for a copy, never stopped by it" 'echo "$out" | grep -qx "BOPS_LOCAL_FAIL=port-held" && kill -0 "$HOLD" 2> /dev/null && [ "$(word "$("$BIN" status shop.sam)" shop.sam--shop 3)" = running ]'
kill "$HOLD" 2> /dev/null
HOLD=
pid1=$(conf shop.sam--shop PID)
out=$("$BIN" forget shop.ivy-2)
check "forget of a copy: its Locals alone" 'echo "$out" | grep -qx "BOPS_LOCAL_FORGOT=1" && [ ! -f "$BOPS_LOCAL_HOME/shop.ivy-2--shop.conf" ] && [ -f "$BOPS_LOCAL_HOME/shop.sam--shop.conf" ] && [ -f "$BOPS_LOCAL_HOME/shop--shop.conf" ]'
check "and its folder is left as it is" '[ -d "$BOPS_APPS_DIR/shop.ivy-2" ]'
check "forget of the app's own folder only: its sites' Locals, never a copy's" '"$BIN" forget shop only | grep -qx "BOPS_LOCAL_FORGOT=2" && [ ! -f "$BOPS_LOCAL_HOME/shop--shop.conf" ] && [ ! -f "$BOPS_LOCAL_HOME/shop--admin.conf" ] && [ ! -f "$BOPS_LOCAL_HOME/shop--shop.env" ] && kill -0 "$pid1" 2> /dev/null'
start shop shop "$(b64 "$SERVE")" - - - - > /dev/null
check "forget of the app: its own and every copy's, the running copy stopped" '"$BIN" forget shop | grep -qx "BOPS_LOCAL_FORGOT=2" && ! ls "$BOPS_LOCAL_HOME" | grep -qE "^shop(--|[.])" && sleep 0.3 && ! kill -0 "$pid1" 2> /dev/null'
check "forget with a word it doesn't know is refused" '[ "$("$BIN" forget shop all)" = BOPS_LOCAL_FAIL=usage ]'

# 16. A copy whose package.json and lockfile are another folder's of the app (its own, or a copy) that has node_modules
# from them: linked file by file (cp -al), never installed again; caches left out; both marked .bops-linked. One with
# another lockfile is installed. An install in a folder whose node_modules is linked takes its own away first, so the
# other's files are never written into.
mkdir -p "$T/npm2" "$BOPS_APPS_DIR/lnk" "$BOPS_APPS_DIR/lnk.sam" "$BOPS_APPS_DIR/lnk.ivy"
cat > "$T/npm2/npm" << EOF
#!/bin/bash
echo "\$PWD" >> "$T/npm2.log"
mkdir -p node_modules/dep
echo "installed in \$PWD" > node_modules/dep/index.js
EOF
chmod +x "$T/npm2/npm"
for d in lnk lnk.sam lnk.ivy; do echo '{"name":"lnk","dependencies":{"dep":"1.0.0"}}' > "$BOPS_APPS_DIR/$d/package.json"; done
for d in lnk lnk.sam; do echo '{"lockfileVersion":3}' > "$BOPS_APPS_DIR/$d/package-lock.json"; done
echo '{"lockfileVersion":3,"other":true}' > "$BOPS_APPS_DIR/lnk.ivy/package-lock.json"
ninstalls() { grep -c . "$T/npm2.log" 2> /dev/null || echo 0; }
inode() { ls -i "$1" 2> /dev/null | awk '{print $1}'; }
lstart() { PATH="$T/npm2:$PATH" start "$1" lnk "$(b64 "$SERVE")" - - - - > /dev/null; sleep 1; }
lstart lnk
check "the app's own folder installs" '[ "$(ninstalls)" = 1 ] && [ -f "$BOPS_APPS_DIR/lnk/node_modules/dep/index.js" ]'
mkdir -p "$BOPS_APPS_DIR/lnk/node_modules/.vite" && echo cache > "$BOPS_APPS_DIR/lnk/node_modules/.vite/deps.js"
lstart lnk.sam
check "a copy with the same package.json and lockfile isn't installed again" '[ "$(ninstalls)" = 1 ]'
check "its node_modules is linked file by file" '[ -n "$(inode "$BOPS_APPS_DIR/lnk/node_modules/dep/index.js")" ] && [ "$(inode "$BOPS_APPS_DIR/lnk.sam/node_modules/dep/index.js")" = "$(inode "$BOPS_APPS_DIR/lnk/node_modules/dep/index.js")" ]'
check "caches left out" '[ ! -e "$BOPS_APPS_DIR/lnk.sam/node_modules/.vite" ] && [ -e "$BOPS_APPS_DIR/lnk/node_modules/.vite/deps.js" ]'
check "both marked linked, and its log says so" '[ -e "$BOPS_APPS_DIR/lnk.sam/node_modules/.bops-linked" ] && [ -e "$BOPS_APPS_DIR/lnk/node_modules/.bops-linked" ] && grep -q "^\$ linked node_modules from $BOPS_APPS_DIR/lnk$" "$BOPS_LOCAL_HOME/lnk.sam--lnk.log"'
check "what it came from is kept, as for an install" '[ "$(conf lnk.sam--lnk PKGHASH)" = "$(conf lnk--lnk PKGHASH)" ]'
lstart lnk.ivy
check "a copy with another lockfile is installed" '[ "$(ninstalls)" = 2 ] && [ "$(tail -n 1 "$T/npm2.log")" = "$BOPS_APPS_DIR/lnk.ivy" ] && [ ! -e "$BOPS_APPS_DIR/lnk.ivy/node_modules/.bops-linked" ]'
echo '{"name":"lnk","dependencies":{"dep":"2.0.0"}}' > "$BOPS_APPS_DIR/lnk/package.json"
lstart lnk
check "an install where node_modules is linked takes its own away first: the copy's files stay as they were" '[ "$(ninstalls)" = 3 ] && [ "$(inode "$BOPS_APPS_DIR/lnk.sam/node_modules/dep/index.js")" != "$(inode "$BOPS_APPS_DIR/lnk/node_modules/dep/index.js")" ] && grep -q "installed in $BOPS_APPS_DIR/lnk$" "$BOPS_APPS_DIR/lnk.sam/node_modules/dep/index.js" && [ ! -e "$BOPS_APPS_DIR/lnk/node_modules/.bops-linked" ]'
for d in lnk lnk.sam lnk.ivy; do "$BIN" stop "$d" lnk > /dev/null; done

echo
[ "$fails" = 0 ] && echo "all passed" || echo "$fails failed"
exit "$fails"
