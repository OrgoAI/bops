# Contributing to Bops

Thanks for helping. A few things keep this smooth.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Security problems go to security@orgo.ai, not issues (see [SECURITY.md](SECURITY.md)).
- Be kind: we follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Contributor License Agreement

Bops is released under FSL-1.1-ALv2, and Organic Intelligence, Inc. also runs a hosted version, so to accept your contribution we need you to sign our Contributor License Agreement (CLA). We'll ask you to before we merge your first pull request. You keep the copyright to your work.

## Development

```bash
npm run setup                # dependencies, .env.local from .env.example, and a git hook
npm run app                  # or: npx next dev --port 3210
```

Fill in `.env.local` as the README's "Run it yourself" says, or set `BOPS_SELF_HOSTED=0` and sign in with Orgo. Work on a branch of your fork (or, on Orgo's team, a `dev/<name>` branch here) and open a pull request against `main`: `main` takes changes only through pull requests, and CI (typecheck, lint and a secret scan) has to pass.

Before you open a pull request:

```bash
npx next typegen                         # route types (next-env.d.ts isn't committed)
npx tsc --noEmit -p .
npx tsc -p cloud/tsconfig.json --noEmit  # Bops Cloud
npm run lint
```

## How the code is written

- Plain, short comments in everyday English, saying what something is for. Match the code around you.
- The person the bots work for is "the user" in comments and fixed prompt text; prompts built at runtime use `ownerName()` / `ownerLine()` from `lib/server/store.ts`. Use they/them, never a gendered pronoun, for the user.
- Never put keys, phone numbers, emails or other personal data in code, prompts, examples or tests. Use `.env.local` for settings and generic examples (alex@example.com, +15551234567).
- Bops only creates or deletes Orgo computers in its own workspace; keep it that way.
- Next.js 16 has breaking changes from older versions: check `node_modules/next/dist/docs/` before using a Next API.
