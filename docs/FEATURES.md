# Feature checks

Run `scripts/verify your-apps` for the focused type, lint, request, permission, password, and UI-component checks. Add `--ui` to drive both 1440px and 1180px windows on the sample two-person stack. The browser fixtures answer website and publishing requests locally; these checks do not claim vendor deployment success.

| Feature | Reach it | Expected result | Files |
|---|---|---|---|
| Your Apps | Sidebar → Your Apps | Equal rows for websites and tools; changed websites lead to review | made-apps.tsx, hosted-apps.tsx, app-controls.tsx |
| Review and publish | Open a website | Preview and Live; explicit confirmation names the reviewed version and destination | app-review.tsx, app-envs.tsx, lib/app-review.ts |
| Password | Preview → Show password | Reveal, copy, Escape; current password fetched from the existing protected route | app-review.tsx, preview-password.tsx |
| Versions | Version history → Restore to preview | Original preview deploy request; publishing remains a separate choice | hosted-apps.tsx, shared-apps.tsx, lib/hosted-apps.ts |
| Advanced actions | Technical details | Local controls for owners; existing GitHub, rollback, and deployment actions | app-envs.tsx |
| App settings | Settings → Technical settings | Existing site/environment commands, variables, domains, and deploy controls | hosted-apps.tsx, app-settings.tsx |
| Shared apps | Admin's shared workspace → Your Apps | Same review flow; only authorized member actions; no Local, variable values, logs, or domain buying | shared-apps.tsx |
