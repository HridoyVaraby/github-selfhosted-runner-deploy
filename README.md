# github-selfhosted-runner-deploy

A reusable **skill + recipe** for AI agents (and humans) to set up:

1. A **GitHub Actions self-hosted runner** running safely in Docker on any Linux machine
2. A **CI/CD pipeline** that lints + builds on push to the production branch and deploys the build output to a **cPanel host over encrypted FTPS** — upload-only, so it can never delete your live files

Everything here came out of a real production deployment where seven separate
things broke before the first green run. Each failure, root cause, and fix is
documented in the **Pitfalls** section so you (or your agent) don't repeat them.

## What's inside

```
SKILL.md                      # the full skill: setup, workflow, deploy script, secrets, pitfalls
examples/workflow-deploy.yml  # ready-to-adapt GitHub Actions workflow
scripts/ftp-deploy.mjs        # safe upload-only FTPS deploy script (basic-ftp)
LICENSE                       # MIT
```

## Quickstart (AI agent friendly)

1. **Runner** — install `docker.io` from apt, fix any stale Docker Desktop
   config, pull `ghcr.io/actions/actions-runner:<version-from-github>`, and run
   with an explicit, idempotent command (the image has no entrypoint!). Get the
   registration token via `gh api` so it never touches chat or disk.
2. **Secrets** — `gh secret set FTP_SERVER/FTP_PORT/FTP_USER/FTP_PASS`.
   ⚠️ To pass a value via stdin, pipe it and OMIT `--body` — `--body -`
   stores a literal `-`.
3. **Workflow** — copy `examples/workflow-deploy.yml`, adjust the package
   manager commands, set the production branch.
4. **Deploy script** — copy `scripts/ftp-deploy.mjs`, add `basic-ftp` as a
   devDependency, point it at your build directory.
5. **Verify** — grep the LIVE deployed bundle for your change. Green CI is not
   proof of deployment; live content is.

## Safety properties

- **Upload-only deploys** — the pipeline physically cannot delete remote files
  (your `.htaccess`, manifests, and media stay safe)
- **Deploy gated behind lint + build** — broken code never ships
- **Encrypted transport** — explicit FTPS (AUTH TLS)
- **Secrets stay in the GitHub vault** — never on disk, never in logs
- **Use a jailed FTP subaccount** scoped to the deploy directory

## Who is this for

- Developers deploying static/SPA builds (Vite, CRA, Next export…) to shared
  cPanel hosting where containers/SSH aren't available
- AI coding agents tasked with "set up CI/CD to my cPanel site"
- Anyone wanting a runner that survives reboots and never ghost-deregisters

## Requirements

- Linux x64 machine (the runner host), Docker, `gh` CLI authenticated
- A GitHub repo, a cPanel (or any FTPS-enabled) host, FTP credentials
- Node project with `lint` and `build` scripts

## License

[MIT](LICENSE) — free to use, modify, and share.
