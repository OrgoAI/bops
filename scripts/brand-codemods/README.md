# Brand codemods

The brand layer (lib/brand.ts, app/globals.css `[data-brand]`) works because the app's grays are tokens and its name is `BRAND.name`. Code from main still writes raw hexes (`text-[#6B6B6B]`) and "Bops", so each merge of main into the brand layer runs these again:

- `palette.py <files>`: each of Bops' neutral hexes in a Tailwind color utility, or inside an arbitrary value (a shadow), becomes its token (`text-[color:var(--c-6b6b6b)]`). Bops' values are the same; a brand's come from its `[data-brand]` block. Only the hexes in its TOKENS list.
- `brand-strings.cjs <files>`: "Bops" in JSX text and string or template literals becomes `BRAND.name`, with the import added. Run it from the repo root (it loads node_modules/typescript). Leave out components/app/sign-in.tsx: its "allow Bops" is Orgo's name for the app.
- `test-palette.py <tests>`: the same hexes in tests that look for a class (a regex `bg-\[#F6F6F4\]` or a string `bg-[#C9C9C6]`).

A file both sides changed merges three ways with the codemods run on both sides, so only hand edits can conflict:

```sh
git merge --no-commit origin/main
for f in $(git diff --name-only --diff-filter=U); do
  git show <merge-base>:$f > /tmp/B; git show origin/main:$f > /tmp/M; git show HEAD:$f > /tmp/O
  python3 scripts/brand-codemods/palette.py /tmp/B /tmp/M; node scripts/brand-codemods/brand-strings.cjs /tmp/B /tmp/M
  git merge-file /tmp/M /tmp/B /tmp/O && cp /tmp/M $f
done
python3 scripts/brand-codemods/palette.py components/app/*.tsx   # main's new code
node scripts/brand-codemods/brand-strings.cjs $(ls components/app/*.tsx | grep -v sign-in.tsx)
```

v0.0.32 went in this way: 19 files, no conflicts left.
