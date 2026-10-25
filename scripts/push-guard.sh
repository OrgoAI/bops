#!/usr/bin/env bash
# bops-public-history-guard: the git pre-push hook scripts/setup.sh installs (a copy of this file). It refuses
# to push history that isn't OrgoAI/bops's to it: everything in that repo descends from its first commit
# (public_root below).
#
# With Orgo's private bops-secrets next to this repo (or at $BOPS_SECRETS), it also refuses new commits (ones
# the remote doesn't have yet) when anything they carry has a private detail (bops-secrets
# docs/private-patterns.txt, less the lines docs/public-allowed.txt allows): a message; a line added or taken
# out; a file's path; a binary file's bytes, read as text, as UTF-16 text, and unpacked when it's compressed
# (one it can't unpack, encrypted or of a kind it has no tool for, is refused: it could say anything); who
# wrote or committed it when that's someone the remote's history doesn't have yet; and an annotated tag's
# name, message or tagger, every tag down when a tag is of a tag, or the name a branch or tag is pushed as.
# All of it goes public with the push, whatever the files end up as, which a check of the files alone never
# sees. It names the commits and never prints what matched.
#
# The public repo however it's addressed: https or ssh, ssh.github.com's port 443, an SSH alias for GitHub
# (~/.ssh/config), its old address, or a fork (any GitHub repo named bops or bops-oss: a public repo's forks
# are public too). A shallow clone can't see as far back as public_root, so there the history check is
# skipped, never the rest.
#
# A newer copy in the checkout that pushes (its scripts/push-guard.sh, with a higher guard_version) takes
# this one's place and runs instead, so a checkout set up long ago is checked as its newest code says.
# Bash 3.2 (macOS's own) runs it.
guard_version=2
public_root=7ce4136c68a2a6e1c5c93f0be68aa82e55aac4de

pushes="$(cat)"

if [ -z "${BOPS_GUARD_UPDATED:-}" ]; then
  newer="$(git rev-parse --show-toplevel 2>/dev/null)/scripts/push-guard.sh"
  v="$(sed -n 's/^guard_version=\([0-9][0-9]*\)$/\1/p' "$newer" 2>/dev/null | head -n 1)"
  if [ "${v:-0}" -gt "$guard_version" ] && grep -q 'bops-public-history-guard' "$newer"; then
    run="$newer"
    # Written beside this one and moved over it: this bash keeps reading the file it started on.
    tmp="$(mktemp "$(dirname "$0")/.pre-push.XXXXXX" 2>/dev/null)"
    if [ -n "$tmp" ] && cp "$newer" "$tmp" && chmod +x "$tmp" && mv -f "$tmp" "$0"; then run="$0"; else rm -f "$tmp"; fi
    BOPS_GUARD_UPDATED=1 exec bash "$run" "$@" <<<"$pushes"
  fi
fi

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# Whether `url` is the public repo, or a fork of it (see above).
public_repo() {
  local url="$1" rest host path ssh=0 real
  case "$url" in
    *://*)
      rest="${url#*://}"
      host="${rest%%/*}"
      path="${rest#"$host"}"
      case "$(lower "${url%%://*}")" in ssh | git+ssh | ssh+git) ssh=1 ;; esac
      ;;
    *)
      # scp-like: [user@]host:path, no slash before the colon.
      host="${url%%:*}"
      case "$host" in "$url" | */*) return 1 ;; esac
      path="${url#*:}"
      ssh=1
      ;;
  esac
  host="${host##*@}"
  case "$host" in \[*) host="${host#\[}"; host="${host%%\]*}" ;; *) host="${host%%:*}" ;; esac
  host="$(lower "$host")"
  case "$host" in
    github.com | www.github.com | ssh.github.com) ;;
    "" | -*) return 1 ;;
    *)
      # An SSH alias: where ssh's own config sends it.
      [ "$ssh" = 1 ] && command -v ssh >/dev/null 2>&1 || return 1
      real="$(ssh -G "$host" 2>/dev/null | awk '$1 == "hostname" { print $2; exit }')"
      case "$(lower "$real")" in github.com | www.github.com | ssh.github.com) ;; *) return 1 ;; esac
      ;;
  esac
  path="$(lower "$path")"
  while [ "${path%/}" != "$path" ]; do path="${path%/}"; done
  path="${path%.git}"
  case "${path##*/}" in bops | bops-oss) return 0 ;; esac
  return 1
}
public_repo "$2" || exit 0
# Said without any password or token in it.
remote_url="$(printf '%s' "$2" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/@]*@#\1#')"

shallow="$(git rev-parse --is-shallow-repository 2>/dev/null)"
while read -r local_ref local_sha _ _; do
  { [ -z "$local_sha" ] || [ "$local_sha" = 0000000000000000000000000000000000000000 ]; } && continue
  # (A tag of a file or a folder is no history at all.)
  if [ "$(git cat-file -t "$local_sha^{}" 2>/dev/null)" != commit ] || { [ "$shallow" != true ] && ! git merge-base --is-ancestor "$public_root" "$local_sha" 2>/dev/null; }; then
    echo "Not pushing $local_ref to $remote_url: it isn't OrgoAI/bops's history (it may be Orgo's private repo's)." >&2
    echo "Work in a fresh clone of https://github.com/OrgoAI/bops (or a branch made from its main)." >&2
    exit 1
  fi
done <<<"$pushes"

secrets="${BOPS_SECRETS:-$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/../bops-secrets}"
patterns="$secrets/docs/private-patterns.txt"
[ -f "$patterns" ] || exit 0
scratch="$(mktemp -d "${TMPDIR:-/tmp}/bops-push-guard.XXXXXX")" || exit 1
trap 'rm -rf "$scratch"' EXIT
grep -v '^#' "$patterns" | grep -v '^$' >"$scratch/rules"
[ -s "$scratch/rules" ] || exit 0
{ grep -v '^#' "$secrets/docs/public-allowed.txt" 2>/dev/null | grep -v '^$'; } >"$scratch/allow"
[ -s "$scratch/allow" ] || printf '\001\n' >"$scratch/allow"
# What the remote has already is public already: only what this push adds is looked at.
known=(--remotes="$1")
[ -n "$(git for-each-ref --count=1 "refs/remotes/$1/" 2>/dev/null)" ] || known=(--remotes)
# Who wrote and committed what it has: a new commit or tag of theirs names no one new.
people="$scratch/people"
printf '\001\n' >"$people"
[ -z "$(git for-each-ref --count=1 refs/remotes/ 2>/dev/null)" ] || git log "${known[@]}" --format='%an <%ae>%n%cn <%ce>' 2>/dev/null | sort -u >>"$people"

# How many of the lines read match a pattern and aren't allowed. Counts only: the lines are never printed.
private() { grep -aE -f "$scratch/rules" | grep -acvF -f "$scratch/allow" || true; }
newcomers() { grep -vxF -f "$people" || true; }
# Bytes as lines of text: each run of printable characters is a line of its own, so in a binary file an
# allowed phrase allows only its own run, never the whole file around it.
runs() { LC_ALL=C tr -cs '\t -~' '\n'; }
# The same bytes with their NULs dropped: UTF-16 text (a .strings file, say) read as text.
wide() { LC_ALL=C tr -d '\000' | runs; }

# A commit's headers past its tree, parents and people: a merged tag's (mergetag) name and message, say, and
# its tagger when that's someone new. Signatures aren't words.
headers() {
  git cat-file commit "$1" 2>/dev/null | awk '
    /^$/ { exit }
    /^[^ ]/ { k = $1; sig = 0 }
    k == "tree" || k == "parent" || k == "author" || k == "committer" || k ~ /^gpgsig/ || /^ tagger / { next }
    /-----BEGIN [A-Z ]*SIGNATURE-----/ { sig = 1 }
    !sig { print }
    /-----END [A-Z ]*SIGNATURE-----/ { sig = 0 }'
  git cat-file commit "$1" 2>/dev/null | sed -n '/^$/q; s/^ tagger \(.*>\) [0-9]* [-+][0-9]*$/\1/p' | newcomers
}

# The blobs a commit changes that git reads as binary (numstat's "-"): each one after, and before (taken
# out, or changed) unless it's a merge. One id a line.
binaries() {
  local c="$1" rec path parent
  parent="$(git rev-parse -q --verify "$c^" 2>/dev/null)"
  git rev-parse -q --verify "$c^2" >/dev/null 2>&1 && parent=""
  git diff-tree -r -c --root --no-commit-id --no-renames --numstat -z "$c" 2>/dev/null | while IFS= read -r -d '' rec; do
    case "$rec" in "-	-	"*) ;; *) continue ;; esac
    path="${rec#-	-	}"
    git rev-parse -q --verify "$c:$path" 2>/dev/null
    [ -z "$parent" ] || git rev-parse -q --verify "$parent:$path" 2>/dev/null
  done | sort -u
}

# Unpacks a compressed file (by its first bytes) to stdout. Returns 2 when it isn't one, 1 when it can't.
UNPACK_MAX=268435456
unpack() {
  local f="$1" magic
  magic="$(od -An -tx1 -N6 "$f" | tr -d ' \n')"
  case "$magic" in
    1f8b08*) gzip -dc <"$f" ;;
    425a683[1-9]*) bzip2 -dc <"$f" ;;
    fd377a585a00) command -v xz >/dev/null 2>&1 && xz -dc <"$f" ;;
    28b52ffd*) command -v zstd >/dev/null 2>&1 && zstd -dcq <"$f" ;;
    504b0304*) command -v unzip >/dev/null 2>&1 && unzip -P '' -p "$f" ;;
    377abcaf271c | 526172211a07 | 526172211a0701) return 1 ;;
    *) return 2 ;;
  esac
}

# How many lines of a binary blob are private, read every way it can hold text (runs, wide, and what it
# unpacks to read the same ways); "sealed" when it's compressed and can't be unpacked, or unpacks to more
# than UNPACK_MAX bytes.
blob_lines() {
  local f="$scratch/blob" u="$scratch/unpacked" got
  git cat-file blob "$1" >"$f" 2>/dev/null || { echo 0; return; }
  unpack "$f" | head -c "$((UNPACK_MAX + 1))" >"$u"
  got="${PIPESTATUS[0]}"
  if [ "$got" = 2 ]; then
    : >"$u"
  elif [ "$got" != 0 ] || [ "$(wc -c <"$u")" -gt "$UNPACK_MAX" ]; then
    echo sealed
    return
  fi
  { runs <"$f"; wide <"$f"; runs <"$u"; wide <"$u"; } | private
}

bad=0
refuse() {
  echo "Not pushing $1 to $remote_url: $2 matching bops-secrets docs/private-patterns.txt." >&2
  bad=1
}
while read -r local_ref local_sha remote_ref _; do
  { [ -z "$local_sha" ] || [ "$local_sha" = 0000000000000000000000000000000000000000 ]; } && continue
  n="$(printf '%s\n' "$remote_ref" | private)"
  [ "${n:-0}" = 0 ] || refuse "$local_ref" "the name it's pushed as has a private detail"
  # An annotated tag's name, message and tagger go public with it: each tag's, when one is of another.
  o="$local_sha"
  while [ "$(git cat-file -t "$o" 2>/dev/null)" = tag ]; do
    n="$( { git cat-file tag "$o" | sed '1,/^$/d'; git cat-file tag "$o" | sed -n '/^$/q; s/^tag //p'; git cat-file tag "$o" | sed -n '/^$/q; s/^tagger \(.*>\) [0-9]* [-+][0-9]*$/\1/p' | newcomers; } | private)"
    [ "${n:-0}" = 0 ] || refuse "$local_ref" "its tag $(git rev-parse --short "$o") has $n line(s) in its name, message or tagger"
    o="$(git cat-file tag "$o" | sed -n '1s/^object //p')"
  done
  for c in $(git rev-list "$local_sha" --not "${known[@]}" 2>/dev/null); do
    # Everything the commit carries: its message and other headers; every path it touches (added, taken out
    # or renamed: the diff's headers, read like any other line); each line it adds or takes out, whatever it
    # starts with; and who wrote and committed it, when that's someone new to the remote.
    n="$( { git -c core.quotePath=false show --format=%B --text -U0 --no-color --no-ext-diff --no-textconv "$c"; headers "$c"; git log -1 --format='%an <%ae>%n%cn <%ce>' "$c" | newcomers; } | private)"
    [ "${n:-0}" = 0 ] || refuse "$local_ref" "commit $(git rev-parse --short "$c") has $n line(s) in its message, paths, diff or authors"
    # A binary file's bytes, read every way they can hold text.
    for b in $(binaries "$c"); do
      n="$(blob_lines "$b")"
      if [ "$n" = sealed ]; then
        echo "Not pushing $local_ref to $remote_url: commit $(git rev-parse --short "$c") has a compressed file this check can't unpack (encrypted, too big, or no tool here for it), so it can't tell what's in it." >&2
        bad=1
      elif [ "${n:-0}" != 0 ]; then
        refuse "$local_ref" "commit $(git rev-parse --short "$c") has $n line(s) in a binary file's text"
      fi
    done
  done
done <<<"$pushes"
[ "$bad" = 0 ] || { echo "Rewrite or squash those commits (or rename the branch or tag) first: everything they carry goes public with them." >&2; exit 1; }
exit 0
