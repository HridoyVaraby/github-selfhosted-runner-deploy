# github-selfhosted-runner-deploy

A reusable **skill + recipe** for AI agents (and humans) to set up:

1. A **GitHub Actions self-hosted runner** running safely in Docker on any Linux machine
2. A **CI/CD pipeline** that lints + builds on push to the production branch, then deploys via whichever pattern fits the target:

| Pattern | Target | Approach |
|---------|--------|----------|
| **A** | Shared hosting / cPanel | Encrypted FTPS, upload-only — can never delete your live files |
| **B** | Dockerized apps | Build image → push to GHCR/Docker Hub → webhook or SSH to redeploy by commit SHA |
| **C** | PaaS / hosts with deploy hooks | Trigger the platform's deploy webhook after gates pass |
| **D** | Any SSH server | rsync over SSH with pinned host keys |

The runner setup and build gates are identical for every pattern — only the
deploy step changes.

Everything here came out of a real production deployment where seven separate
things broke before the first green run. Each failure, root cause, and fix is
documented in the **Pitfalls** section so you (or your agent) don't repeat them.

## What's inside

```
SKILL.md                      # the full skill: runner setup, workflow skeleton, 4 deploy patterns, secrets, pitfalls
examples/workflow-deploy.yml  # ready-to-adapt CI/CD workflow
scripts/ftp-deploy.mjs        # Pattern A: safe upload-only FTPS deploy script (basic-ftp)
LICENSE                       # MIT
```

## Quickstart (AI agent friendly)

1. **Runner** — install `docker.io` from apt, fix any stale Docker Desktop
   config, pull `ghcr.io/actions/actions-runner:<version-from-github>`, and run
   with an explicit, idempotent command (the image has no entrypoint!). Get the
   registration token via `gh api` so it never touches chat or disk.
   (Self-hosted is optional — the same pipeline runs on GitHub-hosted
   `ubuntu-latest` with a one-line change.)
2. **Secrets** — `gh secret set` for your pattern's credentials.
   ⚠️ To pass a value via stdin, pipe it and OMIT `--body` — `--body -`
   stores a literal `-`.
3. **Workflow** — copy `examples/workflow-deploy.yml`, adjust the package
   manager commands, set the production branch.
4. **Deploy step** — pick your pattern from SKILL.md Part 3:
   - **cPanel/shared hosting** → `scripts/ftp-deploy.mjs` + `basic-ftp`
   - **Docker** → `docker/build-push-action` (tag by commit SHA!) + webhook or SSH
   - **PaaS hook** → authenticated `curl` POST, fail the job on non-2xx
   - **SSH server** → rsync with `ssh-keyscan` host pinning
5. **Verify** — fetch the LIVE deployed target and grep for your change.
   Green CI is not proof of deployment; live content is.

## Safety properties

- **Deploy gated behind lint + build** — broken code never ships
- **Non-destructive by default** — FTP uploads never delete; rsync without
  `--delete`; deploys serialized so two pushes can't race
- **Immutable deploys** — the Docker pattern tags images by commit SHA and
  redeploys that exact tag
- **Encrypted transports** — explicit FTPS (AUTH TLS), SSH with pinned host keys
- **Secrets stay in the GitHub vault** — never on disk, never in logs
- **Least-privilege access** — jailed FTP subaccounts, built-in `GITHUB_TOKEN`
  for registry pushes, webhook tokens in secrets (never in URLs in logs)

## Who is this for

- Developers deploying static/SPA builds (Vite, CRA, Next export…) to shared
  cPanel hosting where containers/SSH aren't available
- Teams shipping Dockerized apps from CI, redeploying servers via webhooks
- Anyone using PaaS deploy hooks behind proper CI gates
- AI coding agents tasked with "set up CI/CD for this project"

## Requirements

- A GitHub repo with lint/build scripts (any package manager)
- Self-hosted runner path (optional): Linux x64 machine, Docker, `gh` CLI authenticated
- Deploy target per pattern (FTP creds / registry + webhook receiver / hook URL / SSH key)

## License

[MIT](LICENSE) — free to use, modify, and share.
