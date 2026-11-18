---
name: github-selfhosted-runner-deploy
description: Use when setting up a GitHub Actions self-hosted runner in Docker and a CI/CD pipeline that builds and deploys a static site to a cPanel/FTP host.
version: 2.0.0
license: MIT
metadata:
  category: devops
  tags: [github-actions, ci-cd, self-hosted-runner, docker, ftp, cpanel, webhook, deployment]
---

# GitHub self-hosted runner + CI/CD deploy pipelines

Complete, battle-tested recipe for: **Dockerized GitHub Actions runner on any
Linux box** + **workflows that build/test on push and deploy via whichever
pattern fits the target**:

| Pattern | Target | How |
|---------|--------|-----|
| A | Shared hosting / cPanel | Upload-only FTPS (no deletions) |
| B | Dockerized app | Build image → push registry → webhook or SSH to redeploy |
| C | PaaS / hosts with deploy hooks | Trigger the platform's deploy webhook after gates |
| D | Any SSH-reachable server | rsync over SSH |

The **runner setup and workflow gates are identical for every pattern** — only
the deploy step changes.

Design principles baked into this recipe:

- **Gated deploys.** Lint and build must pass before anything ships.
- **Non-destructive by default.** Prefer upload/rsync/restart patterns that
  cannot wipe production extras. If a pattern must delete, make it a
  deliberate, reviewed choice.
- **Idempotent runner.** The container survives restarts and reboots.
- **Secrets never touch disk or logs.**

---

## Part 1 — Runner in Docker (deploy-pattern agnostic)

### 1.1 Install Docker (repo-managed, auto-updatable)

```bash
sudo apt-get install -y docker.io   # Ubuntu apt repo, not upstream script
systemctl is-active docker          # must print: active
groups | grep -q docker && echo "in docker group" || sudo usermod -aG docker "$USER"
```

### 1.2 Fix a stale Docker Desktop config (very common on dev desktops)

If `docker ps` fails with `docker-credential-desktop not found` or
`~/.docker/desktop/docker.sock`, an old Docker Desktop install is hijacking
the CLI. Edit `~/.docker/config.json` (credential-adjacent file — get user
consent before editing):

```json
{
  "auths": {},
  "currentContext": "default"
}
```

Remove any `"credsStore": "desktop"` and switch `currentContext` from
`desktop-linux` to `default`, then `docker context use default`.

### 1.3 Pull the image tagged to the version GitHub shows

Open the repo → **Settings → Actions → Runners → New self-hosted runner**.
The `config.sh` line shows the current version (e.g. `2.338.2`). Use THAT tag:

```bash
docker pull ghcr.io/actions/actions-runner:2.338.2
```

### 1.4 Get a registration token via API (no copy-paste from the browser)

With `gh` CLI authenticated as a repo admin:

```bash
TOKEN=$(gh api repos/OWNER/REPO/actions/runners/registration-token -X POST --jq '.token')
```

The token is a short-lived secret (~1 hour). Never write it to a file.

### 1.5 Run the runner — EXPLICIT command, idempotent, NOT ephemeral

The official image has **no default entrypoint** — a bare `docker run` exits 0
instantly with empty logs and looks like a crash. Always pass a command, and
make config conditional so restarts don't break:

```bash
docker run -d --name github-runner --restart unless-stopped \
  ghcr.io/actions/actions-runner:2.338.2 \
  bash -c "if [ ! -f .credentials ]; then ./config.sh \
    --url https://github.com/OWNER/REPO --token $TOKEN \
    --name my-runner --labels self-hosted,linux,x64 --work /tmp/workspace \
    --unattended; fi && ./run.sh"
```

- **Do NOT pass `--ephemeral`** for private repos: it deregisters after one
  job, and on container restart the expired token makes the container fail
  forever. Ephemeral hardening matters for PUBLIC repos only.
- Do NOT add `--replace` on a healthy setup; it inherits settings from the
  runner it replaces (including ephemeral-ness) and causes session conflicts.
- Mount `/var/run/docker.sock` ONLY if jobs must use the host's Docker daemon
  — it is root-equivalent on the host. For plain image builds, prefer
  `docker/build-push-action` which runs its own isolated buildx builder.

### 1.6 Verify with logs, not container status

`docker ps` showing "Up" proves nothing (a crashed run-loop still shows Up).
The success line is:

```bash
docker logs github-runner 2>&1 | grep "Listening for Jobs"
```

### 1.7 Ops quick reference

```bash
docker logs --since 5m github-runner          # recent activity
docker logs github-runner | grep -E "Running job|result:"   # job outcomes
gh api repos/OWNER/REPO/actions/runners       # GitHub-side view (status, ephemeral)
# Remove: docker rm -f github-runner, then deregister via the API/UI or the
# orphan shows offline forever:
#   gh api -X DELETE repos/OWNER/REPO/actions/runners/<id>
# Full teardown: deregister → docker rm -f → docker volume rm → rmi images
# → apt-get purge docker.io → rm -rf /var/lib/docker /var/lib/containerd ~/.docker
```

> **Tip:** you don't have to pick a runner type forever. A pipeline can start
> on a self-hosted runner for testing and move to `ubuntu-latest` later with a
> one-line change — secrets and deploy logic carry over unchanged.

---

## Part 2 — Workflow skeleton (same for every pattern)

```yaml
name: CI & Deploy (production)

on:
  push:
    branches: [master]        # production branch only
  workflow_dispatch: {}

concurrency:
  group: production-deploy
  cancel-in-progress: false

jobs:
  ci-deploy:
    runs-on: self-hosted      # or: ubuntu-latest — see notes
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node          # BEFORE pnpm — see pitfall P4
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10             # match lockfile; config-only workspace files need >= 10

      - run: pnpm install --frozen-lockfile
      - run: pnpm lint            # gate
      - run: pnpm build           # gate

      # ↓↓↓ DEPLOY STEP: pick ONE pattern from Part 3 ↓↓↓
```

Notes:

- **No `cache:` in setup-node.** Its pnpm cache support breaks on bare
  self-hosted containers (`packages field missing or empty`).
- For npm projects substitute `npm ci` / `npm run lint` / `npm run build`.
- `concurrency` + `cancel-in-progress: false` serializes deploys — two pushes
  never deploy simultaneously.
- Branch protection: keep the production branch protected; work happens on a
  dev branch and merges in.
- **GitHub-hosted vs self-hosted:** `ubuntu-latest` needs zero maintenance and
  supports every pattern below. Self-hosted wins when you need private-network
  access, big warm caches, or custom hardware.

---

## Part 3 — Deploy patterns

### Pattern A — FTPS upload to shared hosting / cPanel (upload-only)

For hosts where the only door is FTP. Uses `basic-ftp` (pure JS, no system
deps). Add as a devDependency (`pnpm add -D basic-ftp`). Full script in this
repo: `scripts/ftp-deploy.mjs`.

```yaml
      - name: Deploy via FTPS (upload-only, never deletes)
        env:
          FTP_SERVER: ${{ secrets.FTP_SERVER }}
          FTP_PORT: ${{ secrets.FTP_PORT }}
          FTP_USER: ${{ secrets.FTP_USER }}
          FTP_PASS: ${{ secrets.FTP_PASS }}
        run: node scripts/ftp-deploy.mjs
```

Safety properties:

- **No `client.removeDir` / no clearWorkingDir anywhere** — removed-from-build
  files stay on the server (stale hashed asset filenames are harmless; add a
  deliberate cleanup routine later if you truly need one).
- `rejectUnauthorized: false` is required for typical cPanel FTPS (cert is for
  the server hostname, e.g. `serverXX.web-hosting.com`, not `ftp.yourdomain.com`).
  Traffic is still encrypted. If your cert matches, set it to `true`.
- The FTP user should be a **jailed subaccount** scoped to the deploy
  directory, never the primary account.

### Pattern B — Docker image build + registry push, then webhook/SSH redeploy

For containerized apps. Build and push the image, then tell the server to
pull and restart — via webhook (Portainer, Watchtower, Dokploy, Coolify,
custom endpoint) or SSH.

```yaml
permissions:
  contents: read
  packages: write   # required to push to GHCR

jobs:
  ci-deploy:
    # ... gates from Part 2, then:
    steps:
      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}   # built-in, scope-limited

      - name: Build & push image
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ghcr.io/OWNER/APP:${{ github.sha }}
            ghcr.io/OWNER/APP:latest
          cache-from: type=gha          # layer cache (GitHub-hosted runners)
          cache-to: type=gha,mode=max

      - name: Trigger redeploy webhook
        env:
          WEBHOOK_URL: ${{ secrets.DEPLOY_WEBHOOK_URL }}
          WEBHOOK_TOKEN: ${{ secrets.DEPLOY_WEBHOOK_TOKEN }}
        run: |
          code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$WEBHOOK_URL" \
            -H "Authorization: Bearer $WEBHOOK_TOKEN" \
            -H "Content-Type: application/json" \
            -d '{"tag":"${{ github.sha }}"}')
          [ "$code" = "200" ] || { echo "webhook failed: HTTP $code"; exit 1; }
```

Key points:

- **Tag by commit SHA** (immutable) and deploy that tag. Redeploying by
  re-pushing a mutable tag (`:latest`) is how servers silently keep running
  the old image from local cache.
- `secrets.GITHUB_TOKEN` is automatic per-run; prefer it over a personal
  token for registry pushes, but set `permissions:` explicitly.
- The webhook receiver should pull the SHA tag and recreate the container —
  never bake registry creds into images or put them in webhook URLs.
- If the server must pull a private registry image, manage those creds in the
  receiver platform's own secret store.

### Pattern C — Deploy webhook (PaaS / hosts with deploy hooks)

Platforms that build the repo themselves expose a deploy-hook URL. The
workflow's job is gates + notification only — do NOT upload artifacts the
platform will rebuild:

```yaml
      - name: Trigger platform deploy
        env:
          WEBHOOK_URL: ${{ secrets.DEPLOY_WEBHOOK_URL }}   # token often embedded in URL
        run: |
          code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$WEBHOOK_URL")
          case "$code" in 2*) echo "deploy triggered (HTTP $code)";; *)
            echo "webhook failed: HTTP $code"; exit 1;; esac
```

- Keep the full URL in a **secret** — many hook URLs carry a token in the
  query string (`?token=...`); anyone with the URL can deploy.
- Fail the job on non-2xx — fire-and-forget hides failed deploys.

### Pattern D — rsync over SSH

For servers with SSH access. Non-destructive by default (`--delete` omitted —
add it ONLY for a build-output directory that contains nothing else):

```yaml
      - name: Deploy over SSH
        env:
          SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
        run: |
          install -m 600 /dev/null ~/.ssh/id_ed25519
          printf "%s" "$SSH_KEY" > ~/.ssh/id_ed25519
          ssh-keyscan -H HOSTNAME >> ~/.ssh/known_hosts
          rsync -az --chmod=D755,F644 dist/ user@HOSTNAME:/var/www/app/
```

- Store the **private key** as a repo secret (multi-line secrets: pipe via
  stdin — see Part 4).
- `ssh-keyscan` pins the host key: no interactive prompt, no blind trust in CI.

---

## Part 4 — Secrets via GitHub CLI

```bash
gh secret set FTP_SERVER --body "ftp.example.com"
gh secret set FTP_PORT --body "21"
gh secret set FTP_USER --body "deploy@example.com"
printf "%s" "$PASSWORD" | gh secret set FTP_PASS   # stdin, NO --body flag
```

**Critical:** `gh secret set NAME --body -` stores the literal string `-` —
it does NOT mean stdin. To pass via stdin, omit `--body` entirely and pipe.

- Multi-line secrets (SSH private keys): same stdin pattern —
  `printf "%s" "$KEY" | gh secret set DEPLOY_SSH_KEY`.
- Verify a stored secret without revealing it by hashing it in a temporary
  `workflow_dispatch` workflow (`echo -n "$SECRET" | sha256sum | cut -c1-12`)
  and comparing with the local hash. **Trailing whitespace kills logins** — a
  17-char secret for a 16-char password looks identical in GitHub's UI.

---

## Pitfalls (each one cost a real debugging cycle)

General (runner + workflow):

| # | Symptom | Root cause | Fix |
|---|---------|-----------|-----|
| P1 | `docker run` exits 0 instantly, empty logs | Runner image has no default entrypoint | Pass explicit `bash -c` command |
| P2 | Runner dies after first job: `Registration was not found or is not medium trust`, then crash-loop `Cannot configure the runner because it is already configured` | `--ephemeral` registration (or `--replace` inheriting it) + non-idempotent start command | Fresh registration without ephemeral; config only `if [ ! -f .credentials ]` |
| P3 | `TaskAgentSessionConflictException: Conflict` on startup | Stale session from a previous runner with the same name | Self-resolves in ~3 min ("Runner reconnected… Listening for Jobs"). Don't recreate the container |
| P4 | `pnpm preinstall: node: not found` | pnpm setup ran before Node setup (pnpm ≥ 10 installs via npm and needs node) | Put `actions/setup-node` FIRST |
| P5 | `ERROR packages field missing or empty` on install | `pnpm-workspace.yaml` used for config only (no `packages:`) — rejected by pnpm < 10; also setup-node's `cache: pnpm` fails on bare containers | Pin pnpm ≥ 10; drop the cache option |
| P6 | `unexpected argument '--no-save'` | pnpm ≥ 11 removed it | Commit the deploy tool as a devDependency instead |
| P7 | `530 Login authentication failed` despite correct-looking secrets | Secret stored wrong (literal `-` from `--body -`, or trailing char from manual paste) | Re-set via stdin pipe; verify by hash in a debug workflow |

Pattern-specific:

| Pattern | Gotcha |
|---------|--------|
| B | `denied: permission_denied` pushing to GHCR → add `permissions: packages: write` to the workflow |
| B | Server "redeploys" but runs old code → pulled a mutable tag from local cache; deploy by SHA tag |
| C | Hook URL with embedded token leaked via logs → keep in secrets, never echo |
| A | Cert hostname mismatch on cPanel FTPS → `rejectUnauthorized: false` (still encrypted) |

## Verification doctrine

Gates passing is not proof of deployment. After a green run, check the LIVE
target with a real request: fetch the deployed page/bundle and grep for the
change you just made (new filename hash, new string); for containers, hit the
health endpoint and confirm the running image tag. Only a live-content match
means deployed.
