# Publishing

This is how the plugin gets from this folder to someone else's machine. Three steps: GitHub, npm, then tell people the install line.

## 0. Before the first publish

```sh
npm view opencode-openchamber-remote version   # 404 means the name is free
npm test
npm run typecheck
npm pack --dry-run                             # what actually ships
```

What ships is decided by `files` in `package.json`: `src`, `README.md`, `LICENSE`. Tests, scripts and `node_modules` stay out.

If the name is taken, change `name` in `package.json` and the install line below. Keep it lowercase and prefixed with `opencode-` so people can find it.

You need an npm account: <https://www.npmjs.com/signup>. Then `npm login` once on this machine.

## 0.5. Scrub before the first push

Nothing in this repo should point at a real machine. Before the first push, and again before making a private repo public:

```sh
# real addresses, tokens, session ids, machine names, paths under your home
git grep -n -I -E "oc_client_[A-Za-z0-9_-]{8,}|[0-9]{1,3}(\.[0-9]{1,3}){3}|ses_[A-Za-z0-9]{6,}|/home/[a-z]|/root/|C:\\\\Users"
# an email or a real name in the history, not just the files
git log --format="%an <%ae>"
```

Examples in the README use `build.example.com`, `192.0.2.x` and `/srv/app` on purpose: those are reserved for documentation, so nobody mistakes them for a live host. Keep it that way when you add examples.

The commit author is set per repo, not globally:

```sh
git config user.name "LuckyHead11"
git config user.email "93405290+LuckyHead11@users.noreply.github.com"
```

That keeps your real address out of the history GitHub publishes. If a commit already carries it, rewrite it before pushing: `git commit --amend --reset-author` for the last one, or `git filter-repo` for more.

## 1. Put it on GitHub

```sh
git add -A
git commit -m "opencode-openchamber-remote 0.1.0"
git branch -M main
git remote add origin https://github.com/LuckyHead11/opencode-openchamber-remote.git
git push -u origin main
```

Create the empty repo first, at <https://github.com/new> — no README, no license, no `.gitignore`, or the push will be rejected. Pick **Private**. If you install the GitHub CLI (`winget install GitHub.cli`), one command does it:

```sh
gh repo create opencode-openchamber-remote --private --source . --push
```

`repository` in `package.json` must match the repo you pushed to; npm shows it as the link on the package page.

The CI workflow in `.github/workflows/ci.yml` runs tests and typecheck on every push and pull request. It needs nothing configured.

Making a private repo public later is one click under **Settings → General → Danger Zone**, but re-run the scrub in section 0.5 first — history keeps everything you ever committed.

## 2. Publish to npm

```sh
npm publish
```

Then check it is really there:

```sh
npm view opencode-openchamber-remote
```

Two things that catch people:

- **Already published this version?** npm refuses. Bump `version` first (see below).
- **`prepublishOnly` / build steps?** There are none. The package ships TypeScript and OpenCode runs it directly.

## 3. How others install it

```sh
opencode plugin add opencode-openchamber-remote
```

or in `opencode.json`:

```jsonc
{
  "plugins": ["opencode-openchamber-remote"]
}
```

Straight from git, without npm:

```sh
opencode plugin add github:LuckyHead11/opencode-openchamber-remote
```

A private repo works only where git already has credentials for it; for a shared install, publish to npm instead.

They still need a host to talk to: either an OpenChamber desktop that already saved one, or `~/.config/openchamber/remote-hosts.json` with an `apiUrl` and a paired `clientToken`. That part is in the [README](./README.md#where-hosts-come-from).

## 4. Releasing a change

```sh
npm version patch     # or minor / major; also makes the git tag
git push --follow-tags
npm publish
```

- **patch** — bug fix, same behaviour.
- **minor** — a new argument or tool, existing calls still work.
- **major** — the tool names, arguments or result shape change.

Users on `opencode plugin add <name>` follow the version they installed; people who wrote `opencode-openchamber-remote@latest` (or a range) get updates on the next OpenCode start.

## 5. Staying compatible

`@opencode/plugin` is pinned to the OpenCode release this was built against (`^2.3.0`). When OpenCode moves its plugin contract:

1. Bump `@opencode/plugin` here, `npm install`, fix the type errors.
2. Test against a real instance of that release (`npm run smoke`, then one `remote_send`).
3. Publish a matching release and say which OpenCode version it needs in the README's Compatibility section.

Do not publish a version you have not run against a real second instance. The read-only tools can be checked with `npm run smoke`; the write path needs one throwaway session on a machine you own.

## 6. Optional polish

- **GitHub release**: `gh release create v0.1.0 --notes "First release"`.
- **Topics** on the repo: `opencode`, `openchamber`, `opencode-plugin`, `ai-agents`.
- **A screenshot** of a real exchange in the README sells it better than a feature list.
