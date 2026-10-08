Format: one file per version (`v0.0.11.md`), one to five lines starting with "- ", each 12 words or fewer, on what a user notices.

# What's new in each version

Between releases, the lines collect in `next.md`: add one when something users will notice lands, a feature or a fix. In the release commit, Orgo's release script (`scripts/next-release.sh` in its private OrgoAI/bops-secrets) puts them in the new version's file and empties `next.md`. The file stays, so a line a branch adds to it later can't be merged into a version that's out already. Before it builds anything, it stops when there's no file, no line, more than five lines, a line over 12 words, or a private detail.

Each version's lines become:

- its GitHub release notes, with the line on signing and notarization under them;
- "What's new" in the app's notice that a newer Bops is out, and on bops.bot's download card (both read `/download/latest.json`, which `scripts/download-publish.sh` writes).

Write for the people using Bops: what they can do now, or what works better. Plain words: no branch names, pull requests, file paths or settings, and no names of people.

```markdown
- Pick the area code when you get a bot a phone number.
- The update notice now lists what's new in each version.
```
