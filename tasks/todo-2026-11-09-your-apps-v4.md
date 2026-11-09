# Your Apps v4 — waiting for mock approval

Goal: finish the attached brief, including Abhay's yes on the mock, real behavior preserved, both-width click proof, one Claude review and a Draft PR. STOP at step 3 until Abhay explicitly approves the mock. No approval has been received.

Work ONLY in `/Users/abhayp/wt/bops-your-apps-v4`, branch `dev/your-apps-v4`, based on origin/main `1e1beae`. Do not touch the dirty source worktree or installed Bops. No main push, no real workspaces, no secrets reads.

Brief: `/Users/abhayp/.codex/attachments/367388db-35c1-4375-877a-1b888cc14b1e/pasted-text-1.txt`.
Artifacts: `/Users/abhayp/Downloads/orgo_repo/output/2026-11-09-bops-your-apps-v4/`.
Read PLAN.md and COMPONENT-AUDIT.md there. wireframes.html covers four screens. before/ has 16 original captures; mock/ has 10 captures (home/app/settings/Admin/restored-preview at 1440/1180). mock-checks.log records all static checks passing. secscan.log is PASS. Real components and lib are unchanged.

Temporary routes: `app/your-apps-v4/page.tsx` (static data + shipped shell) and `references/page.tsx` (imports actual siblings). Three harness files copied from origin/dev/your-apps-redesign, no visual code. test-your-apps-e2e.mjs has --mock and --siblings modes plus a before-only path for main's inline settings. Mock/gallery runs require types/lint and reject real-component changes or handwritten SVG. Before/after mode remains for later real implementation and will need selectors/checks adapted to the approved layout.

References: inspected Lovable list and publish panel look-only. Abhay signed into Vercel himself; then inspected its live Team Deployments list, no writes. Official list image is also in references/. App siblings captured from local sample stack. Private sibling CSS recipes copied only into mock; after yes extract shared pieces and make the sibling import them, rather than fork permanent controls.

Next:
1. Wait for Abhay's approval or requested mock changes. Do not infer approval from the Vercel login messages.
2. After yes: carry only allowed appStatus restored-preview fix, openChat(id,stay), and nested-control propagation fixes. Implement home, app, settings, Admin in slices; preserve every original request body.
3. Delete both temporary routes before PR. Complete exact type/lint, both-width click and named regression gates in brief. One Claude review. Scan, push branch, Draft PR only. Abhay marks Ready.

Known boundary: static Restore only moves a mock tag; no publishing/settings/domain operation was implemented or proven. Full real-app behavior tests not run. The sample stack is stopped at handoff. Restart: `TWO_PERSON_MEMBER_ROLE=admin node scripts/dev-two-person.mjs start`. Recreate mock screenshots: set YOUR_APPS_OUT to artifact mock/ and run `node scripts/test-your-apps-e2e.mjs --shots mock --look --mock`.

Skills: app-redesign, staff-engineer-workflow, abhay-language.
