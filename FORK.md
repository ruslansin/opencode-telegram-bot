# Fork / Derivative Workflow

This project is often used as a base for a personal derivative (a fork) with custom features on top of upstream. This document describes the recommended way to keep such a fork in sync and to publish custom work.

The general idea: **upstream is read-only, `main` is an exact mirror of upstream, and every custom change lives on its own feature branch.**

## Repositories and remotes

| Remote   | URL                                                | Role                          |
| -------- | -------------------------------------------------- | ----------------------------- |
| `origin` | https://github.com/grinev/opencode-telegram-bot    | Upstream, read-only           |
| `fork`   | https://github.com/ruslansin/opencode-telegram-bot | Your fork, the push target    |

In this repository `origin` points to upstream and `fork` to the personal fork, and `remote.pushDefault` is set to `fork` so a plain `git push` never targets upstream.

## Golden rules

- Never commit to `main`. Keep it a fast-forward mirror of `origin/main`.
- One logical change per branch, following the naming rules in [`CONTRIBUTING.md`](./CONTRIBUTING.md).
- Treat the `custom` integration branch as generated: build it from `main` plus the active feature branches, and never commit to it directly.
- Update a feature branch by **rebasing** it onto `main`, never by merging upstream into it. A linear history stays easy to rebase.
- Force-push only your own feature branches, and only with `--force-with-lease`.
- Re-run the quality checks after every rebase.

## One-time setup

```bash
git remote add fork https://github.com/ruslansin/opencode-telegram-bot.git
git fetch origin --tags
git fetch fork
git config remote.pushDefault fork
```

## Start a new feature

```bash
git fetch origin
git checkout main
git merge --ff-only origin/main
git checkout -b feat/my-feature

# ... implement, then ...
git push -u fork feat/my-feature
```

`git push -u` records `fork` as the push remote for the branch, so later pushes are just `git push`.

## Sync with upstream (new release)

```bash
git fetch origin --tags
git checkout main
git merge --ff-only origin/main        # or, without checkout: git branch -f main origin/main

git checkout feat/my-feature
git rebase main
# resolve any conflicts, then:
git push --force-with-lease fork feat/my-feature
```

`main` can also be synced back to the fork:

```bash
git push fork main
```

## Assembling custom features (`custom` branch)

Feature branches keep changes isolated, but to run the bot with all custom features at once, merge them into a single integration branch, `custom`. It is a long-lived branch built on top of `main`; `main` itself stays a clean mirror of upstream.

Create it once:

```bash
git fetch origin
git checkout main && git merge --ff-only origin/main
git checkout -b custom
git merge --no-ff docs/fork-guide
git merge --no-ff feat/OTB-224-idle-shutdown-on-demand
git push -u fork custom
```

Add another feature later:

```bash
git checkout custom
git merge --no-ff feat/my-feature
git push fork custom
```

Run everything locally:

```bash
git checkout custom
cp .env.example .env        # set the bot token, user ID, and model
npm install
npm run dev                 # build and start
```

After an upstream release, rebase each feature and rebuild `custom` from scratch so the result is deterministic:

```bash
git fetch origin
git checkout main && git merge --ff-only origin/main

git rebase main feat/OTB-224-idle-shutdown-on-demand
git rebase main feat/my-feature

git checkout custom
git reset --hard main
git merge --no-ff docs/fork-guide
git merge --no-ff feat/OTB-224-idle-shutdown-on-demand
git merge --no-ff feat/my-feature
git push --force-with-lease fork custom
```

Then run the check suite. If two features touch the same files, resolve the conflicts during the individual merges.

## Updating and removing custom features

Treat `custom` as a **generated branch**: it is always exactly `main` plus the current set of active feature branches. Never commit to `custom` directly. Every change is made on a feature branch, then `custom` is rebuilt. This keeps it reproducible and makes updates and removals predictable.

Keep an explicit list of the active branches, for example:

```text
docs/fork-guide
feat/OTB-224-idle-shutdown-on-demand
feat/my-feature
```

This document itself lives on `docs/fork-guide`, so the workflow guide is part of the active set and survives every rebuild.

### Update a feature

```bash
git fetch origin
git checkout main && git merge --ff-only origin/main

git checkout feat/my-feature
git rebase main
# make and commit changes
git push --force-with-lease fork feat/my-feature

# rebuild custom from the active set
git checkout custom
git reset --hard main
git merge --no-ff docs/fork-guide
git merge --no-ff feat/OTB-224-idle-shutdown-on-demand
git merge --no-ff feat/my-feature
git push --force-with-lease fork custom
```

### Remove a feature

Rebuild `custom` without merging that branch:

```bash
git checkout custom
git reset --hard main
git merge --no-ff docs/fork-guide
git merge --no-ff feat/OTB-224-idle-shutdown-on-demand
# feat/my-feature intentionally omitted
git push --force-with-lease fork custom
```

The feature branch itself is left untouched. Delete it only when you no longer need it:

```bash
git branch -D feat/my-feature
git push fork --delete feat/my-feature
```

### Resolve conflicts on the feature branch, not on `custom`

If a merge into `custom` conflicts, fix the feature branch (rebase it onto `main` and resolve there) and then rebuild `custom`. Never resolve conflicts by committing directly on `custom`: the next rebuild would discard that work and silently change behavior.

## GitHub "Sync fork"

The GitHub UI can fast-forward the fork's default branch to upstream:

1. Open https://github.com/ruslansin/opencode-telegram-bot (branch `main`).
2. Click **Sync fork** next to the branch selector, then **Update branch**.

Notes:

- This only syncs the fork's default branch (`main`); feature branches are never touched.
- GitHub has no built-in scheduled sync for forks. It is a manual button.
- If the fork's `main` has diverged, GitHub offers **Discard commits**. This is another reason to keep custom commits off `main`.
- With the `gh` CLI installed and authenticated, the same action is:
  ```bash
  gh repo sync ruslansin/opencode-telegram-bot -b main
  ```

## Resolving rebase conflicts

Conflicts are expected while upstream evolves. Two recurring cases in this project:

- **New locale added upstream.** A new dictionary file (for example `src/i18n/tr.ts`) will not contain the keys introduced by your custom features. Add the missing translations to the new locale; the `I18nDictionary` type and `npm run build` fail until every locale is complete.
- **Documentation tables.** `.env.example` and `README.md` are edited upstream often. Keep the upstream wording and re-apply your rows/columns on top.

Always finish with the full check suite:

```bash
npm run build
npm run lint
npm run typecheck
npm test
```

## Optional: automated fork sync

GitHub does not schedule fork syncs, but a small scheduled workflow in the fork can run `gh repo sync` (or push `origin/main` to `main`) on a cron. This requires a token stored in the fork's Actions secrets. Add it only if manual sync becomes a burden.
