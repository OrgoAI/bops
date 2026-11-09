# Your Apps v4 — second mock awaiting review

Work ONLY in `/Users/abhayp/wt/bops-your-apps-v4`, branch `dev/your-apps-v4`, base origin/main `1e1beae`. Full goal remains the attached brief: approved mock, real behavior preserved, both-width click proof, one Claude review, Draft PR. No push, real workspaces, installed Bops, secrets or domain feature.

Brief: `/Users/abhayp/.codex/attachments/367388db-35c1-4375-877a-1b888cc14b1e/pasted-text-1.txt`.
Artifacts: `/Users/abhayp/Downloads/orgo_repo/output/2026-11-09-bops-your-apps-v4/`.

Abhay approved the first mock's look but requested another iteration for nontechnical BrandLord users. Keep it minimal: controls explain the path; no paragraphs/eyebrows. This is NOT approval to implement the real pages. Wait for his yes on the second mock.

Read PLAN-ITERATION-2.md and PROOF-ITERATION-2.md. Original before/ has 16 captures; first mock/ retained; second mock/iteration-2/ has 24 captures at 1440/1180. mock-intuition-red.log: four missing entry-path checks fail on first mock. mock-iteration-2-checks.log: 69 PASS, no FAIL/errors, exit 0. Types/lint gated before capture. Source components/lib/manifests untouched.

Second mock: home Review changes + unpublished tag; app Preview / Live, Open preview, Show password, Publish changes. Password reveal/copy/Escape tested. Final publish uses actual AskInPlace, names version and GitHub destination, cancellation preserves unpublished state. Current/behind states tested. History and technical detail disclosures hold raw versions/Local. Admin has no Local. Temporary preview route is only a local sample destination; publication/restore change page memory only.

Technical fact: Local is Boppy's working folder. GitHub publishing sends the reviewed preview to the repo; it does not prove the website went live. Confirm must say that honestly. REA captured first-party Lovable/Vercel publishing docs, not authenticated deployment actions; evidence and screenshots under references/rea-*. Findings and feedback recorded in vault Bops Your Apps Redesign.md, lesson L798.

Next: iterate mock or receive explicit yes. After yes, carry only allowed appStatus/restored-preview, openChat(id,stay), nested-control fixes; extract shared recipes with sibling imports. Implement home/app/settings/Admin in slices; preserve request bodies. Delete all app/your-apps-v4/ routes before PR. Run every exact gate in brief and Claude review; scan, branch push, Draft PR only.

Sample stack stopped, seven ports clear. Restart: `TWO_PERSON_MEMBER_ROLE=admin node scripts/dev-two-person.mjs start`. Capture: YOUR_APPS_OUT=<artifact>/mock/iteration-2 node scripts/test-your-apps-e2e.mjs --shots mock --look --mock. A stale generated .next/dev route type had duplicate tail bytes; npx next typegen alone targets prod, so stopped stack and used BOPS_NEXT_DIST_DIR=.next/dev npx next typegen; restored tsconfig formatting, types pass. Don't bypass gates.

Skills: app-redesign, staff-engineer-workflow, abhay-language.
