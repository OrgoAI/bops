# Your Apps review flow

The home has one list for websites and tools. A changed website opens review rather than publishing directly. Preview is the review copy; Live shows the published version, or the version last sent to GitHub. Technical detail stays available one level deeper.

| Acceptance | Proof |
|---|---|
| Equal rows at both widths; no Local controls or direct publish on home | Browser checks (the before and after pictures are in the PR description's history, not in the repo) |
| Review preview, reveal/copy password, Escape, Live, and Ask Boppy do what they say | Browser checks at 1440px and 1180px |
| Pending previews and review entries use the existing highlighter; quiet/working/failed states do not borrow it | Rendered UI regression and browser color checks |
| Final confirmation quiets the earlier review action; cancellation restores it; editing remains available | Mounted UI, browser checks and Ask Boppy's unsent draft |
| In the narrow owner view, Publish stays left-aligned on its second action line | Browser bounding boxes at 1180px |
| Publishing names the version/destination, allows cancellation, and refuses a moved preview | Browser checks; server retains its existing pinned request |
| Restore changes Preview and preserves a separate Publish action | Browser checks and test-app-status.mjs |
| Settings, domains, rollback, GitHub tools, multi-site actions, Local and copies retain their request bodies | test-hosted-apps-ui.mjs; representative owner/Admin browser requests |
| Members keep Read/Write/Admin boundaries; owner-only tools stay private | test-hosted-apps-ui.mjs and test-shared.mjs |
| An Admin keeps Update preview beside Publish, and never gets an Add a domain they can't use | test-hosted-apps-ui.mjs |
| An Admin's review of an app on GitHub reads Live from the last push (SharedApp.github.at), and Publish's confirmation says where it goes: the repo and branch, or a domain not pointed at Orgo yet | test-hosted-apps-ui.mjs and cloud/test/core-members.test.ts |
| A failed preview update still lets what the preview serves be published | test-app-status.mjs |
| Existing Bops controls, shared CRM picker, lucide icons, reduced motion | Source audit, types/lint, browser pictures |

Run `scripts/verify your-apps --ui`. The browser uses the local sample stack and answers publishing requests locally. It proves the UI and requests, not real GitHub or production deployment. No domain feature, dependency, auth contract or server handler changes. Bops Cloud adds one field to what members see of an app on GitHub (SharedApp.github.at, the changeset last sent there); from a Bops Cloud without it, an Admin's review reads Live from Published as before and Publish stays pressable. Revert the feature commit to roll back the UI.

This fresh pass replaces the rejected mock in Draft #184. #179's words for where Publish goes (GitHub, or a domain not pointed at Orgo yet) are said in an Admin's Publish confirmation, as its line and destination.

The approved [Paper color pass](https://app.paper.design/file/01M7177KTDR3NA8P96W6S1GT14/p-1-0/7B-0) emphasizes a pending decision with Bops' highlighter and a named Review preview action. “Unpublished” retains its preview/release meaning; review approval is not tracked and editing stays available. Info recommends reviewing the batch before unrelated work, while allowing refinement of the same change. The final publish confirmation keeps the preceding review action quiet.

Original v4 review: Claude Opus 5.5 approved after one full review and a bounded delta. Checks: types/lint clean; app UI 80, status 13, password 10, sharing 70; browser 72 PASS with zero page/console errors at both widths. Seven review regressions failed before their fixes and pass afterward.

Color follow-up checks: types/lint clean; app UI 83, status 13, password 10, sharing 70. Browser checks: 91 PASS at 1440/1180 with no page or console errors. Three new regressions were added; the relevant pending/confirmation cases failed before implementation.

Claude Opus 5.5 independently reran the focused gate and approved this color follow-up after one full review and a bounded screenshot delta. Captures finish finite animations before saving; both Admin pictures now show the open review controls.
