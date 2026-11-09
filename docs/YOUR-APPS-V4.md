# Your Apps review flow

The home has one list for websites and tools. A changed website opens review rather than publishing directly. Preview is the review copy; Live shows the published version, or the version last sent to GitHub. Technical detail stays available one level deeper.

| Acceptance | Proof |
|---|---|
| Equal rows at both widths; no Local controls or direct publish on home | Browser checks and [pictures](proof/your-apps-v4/README.md) |
| Open preview, reveal/copy password, Escape, Live, and Ask Boppy do what they say | Browser checks at 1440px and 1180px |
| Publishing names the version/destination, allows cancellation, and refuses a moved preview | Browser checks; server retains its existing pinned request |
| Restore changes Preview and preserves a separate Publish action | Browser checks and test-app-status.mjs |
| Settings, domains, rollback, GitHub tools, multi-site actions, Local and copies retain their request bodies | test-hosted-apps-ui.mjs; representative owner/Admin browser requests |
| Members keep Read/Write/Admin boundaries; owner-only tools stay private | test-hosted-apps-ui.mjs and test-shared.mjs |
| Existing Bops controls, shared CRM picker, lucide icons, reduced motion | Source audit, types/lint, browser pictures |

Run `scripts/verify your-apps --ui`. The browser uses the local sample stack and answers publishing requests locally. It proves the UI and requests, not real GitHub or production deployment. No domain feature, dependency, auth contract, server handler, or installed Bops change is included. Revert the feature commit to roll back the UI.

This fresh pass replaces the rejected mock in Draft #184. Related #179 carries a separate server/cloud explanation of publishing destinations; this UI keeps those contracts untouched and uses an honest confirmation for the destination currently available to it.

Independent review: Claude Opus 5.5 approved after one full review and a bounded delta. Final checks: types/lint clean; app UI 80, status 13, password 10, sharing 70; browser 72 PASS with zero page/console errors at both widths. Seven review regressions failed before their fixes and pass afterward.
