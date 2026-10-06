# Contributing to Bops

Thanks for helping. A few things keep this smooth.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Security problems: [report them privately](https://github.com/OrgoAI/bops-oss/security/advisories/new), not in issues (see [SECURITY.md](SECURITY.md)).
- Be kind: we follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Contributor License Agreement

Bops is released under FSL-1.1-ALv2, and Organic Intelligence, Inc. also runs a hosted version. Before we merge your first pull request, we'll ask you to sign our CLA. You keep the copyright to your work.

## Development

```bash
npm install
cp .env.example .env.local   # at least OPENAI_API_KEY and ORGO_API_KEY
npm run app                  # or: npx next dev --port 3210
```

Before you open a pull request:

```bash
npx tsc --noEmit -p .
npm run lint
```

## How the code is written

- Plain, short comments in everyday English, saying what something is for. Match the code around you.
- The person the bots work for is "the user" in comments and fixed prompt text; prompts built at runtime use `ownerName()` / `ownerLine()` from `lib/server/store.ts`. Use they/them, never a gendered pronoun, for the user.
- Never put keys, phone numbers, emails or other personal data in code, prompts, examples or tests. Use `.env.local` for settings and generic examples (alex@example.com, +15551234567).
- Bops only creates or deletes Orgo computers in its own workspace; keep it that way.
- Next.js 16 has breaking changes from older versions: check `node_modules/next/dist/docs/` before using a Next API.
