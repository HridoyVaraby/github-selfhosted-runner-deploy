---
name: github-selfhosted-runner-deploy
description: Use when setting up a GitHub Actions self-hosted runner in Docker and a CI/CD pipeline that builds and deploys a static site to a cPanel/FTP host.
version: 2.1.0
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
| D | Any SSH-reachable server | rsync over SSH with verified host keys |

The **runner setup and workflow gates are identical for every pattern** — only
the deploy step changes.

Design principles baked into this recipe:

- **Gated deploys.** Lint and build must pass before anything ships.
- **Non-destructive by default.** Prefer upload/rsync/restart patterns that
  cannot wipe production extras. If a pattern must delete, make it a
  deliberate, reviewed choice.
- **Immutable deploys.** Docker pattern tags images by commit SHA, never
  mutable tags.
- **Secrets never touch disk or logs** — and short-lived tokens are treated
  as secrets even when they expire within the hour.
- **Verify the live target.** A green CI run is never accepted as proof of
  deployment.

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
The `config.sh` line shows the current version (e.g. `2.338.2`). Pin it via a
variable so updates are a one-line change:

```bash
RUNNER_VERSION=2.338.2   # match the version shown on the GitHub runners page
docker pull ghcr.io/actions/actions-runner:$RUNNER_VERSION
```

### 1.4 Get a registration token via API (no copy-paste from the browser)

With `gh` CLI authenticated as a repo admin:

```bash
TOKEN=$(gh api repos/OWNER/REPO/actions/runners/registration-token -X POST --jq '.token')
```

The token expires in about an hour. Treat it as a secret for that hour (see
1.6 for how to keep it out of the container command string).

### 1.5 Runner mode: ephemeral vs persistent (a security decision)

Both modes work for public AND private repos — this is a **risk decision**,
not a repo-visibility rule:

- **Ephemeral** (`--ephemeral`): the runner deregisters after one job. GitHub
  recommends it because it limits *persistent compromise* — code from a
  compromised dependency or workflow cannot sit in the runner waiting for the
  next job. The cost: something must re-register after every job. Plain
  `restart: unless-stopped` Docker does NOT fit ephemeral runners (the
  container restarts with an already-consumed registration and crash-loops
  forever — this bit us in production). Ephemeral fits orchestrators built for
  it (Kubernetes operator, autoscaler fleets, short-lived VMs/containers).
- **Persistent** (no flag): survives across jobs; operationally simple for a
  personally-owned runner that only runs **trusted workflows from protected
  branches**. Acceptable when the runner host holds no unrelated secrets, the
  repo is private, branch protection is on, and untrusted pull requests do
  **not** run workflows on it. This recipe defaults to persistent because its
  audience runs their own single-runner box.

**Hard rule either way:** never let fork pull-request workflows execute on a
self-hosted runner — a workflow step runs arbitrary code with full access to
the runner host. GitHub's own guidance: don't use self-hosted runners for
public repos or fork PRs. Strong default architecture: CI gates on
GitHub-hosted runners, the deploy job alone on the self-hosted box (split the
job with `needs:`). See Part 2 notes.

### 1.6 Run the runner — EXPLICIT command, idempotent, token via env

The official image has **no default entrypoint** — a bare `docker run` exits 0
instantly with empty logs and looks like a crash. Always pass a command, make
config conditional so restarts don't break, and pass the token through an
environment variable instead of interpolating it into the command string (an
interpolated token lands in `docker inspect` output and shell history):

```bash
docker run -d --name github-runner --restart unless-stopped \
  -e RUNNER_REG_TOKEN="$TOKEN" \
  ghcr.io/actions/actions-runner:$RUNNER_VERSION \
  bash -c 'if [ ! -f .credentials ]; then ./config.sh \
    --url https://github.com/OWNER/REPO --token "$RUNNER_REG_TOKEN" \
    --name my-runner --labels self-hosted,linux,x64 --work /tmp/workspace \
    --unattended; fi && ./run.sh'
```

**Honest caveat — token exposure surface:** both container commands and env
vars are readable via `docker inspect` on the host. The token is short-lived
(~1h) and single-use after registration, which is the practical mitigation on
a single-owner box; on shared/multi-tenant hosts, deregister and re-register
after setup completes.

- Do NOT add `--replace` on a healthy setup; it inherits settings from the
  runner it replaces (including ephemeral-ness) and causes session conflicts.
  `--replace` IS the right tool when you deliberately swap a same-named
  runner — just know what you're replacing.
- Mount `/var/run/docker.sock` ONLY if jobs must use the host's Docker daemon
  — it is root-equivalent on the host. For plain image builds, prefer
  `docker/build-push-action`, which runs its own isolated buildx builder.

### 1.7 Persistence across container recreation

`--restart unless-stopped` handles process restarts; the runner's registration
(`.credentials`) still lives in the container's writable layer — removing and
recreating the container loses it (re-register to recover). To make
registration survive recreation, put it on a **named volume** (Docker copies
the image's runner files into an empty named volume on first mount):

```bash
docker run -d --name github-runner --restart unless-stopped \
  -v runner-conf:/home/runner \
  -e RUNNER_REG_TOKEN="$TOKEN" \
  ghcr.io/actions/actions-runner:$RUNNER_VERSION \
  bash -c '...'   # same command as 1.6
```

Trade-off: the volume keeps the OLD runner version across image upgrades —
rotate deliberately (delete + recreate the volume when you upgrade).

Or use **Docker Compose** (cleaner lifecycle):

```yaml
services:
  runner:
    image: ghcr.io/actions/actions-runner:2.338.2   # pin to the current version
    restart: unless-stopped
    environment:
      RUNNER_REG_TOKEN: "${RUNNER_REG_TOKEN}"   # export before: docker compose up -d
    volumes:
      - runner-conf:/home/runner
    command: >
      bash -c 'if [ ! -f .credentials ]; then ./config.sh
      --url https://github.com/OWNER/REPO --token "$$RUNNER_REG_TOKEN"
      --name my-runner --work /tmp/workspace --unattended; fi && ./run.sh'
volumes:
  runner-conf:
```

**Recovery procedure** (registration lost/invalid — runner shows offline
forever): deregister server-side, remove container (and stale volume),
re-register fresh:

```bash
gh api repos/OWNER/REPO/actions/runners   # find the id
gh api -X DELETE repos/OWNER/REPO/actions/runners/<id>
docker rm -f github-runner   # then re-run 1.6 with a fresh token
```

### 1.8 Verify with logs, not container status

`docker ps` showing "Up" proves nothing (a crashed run-loop still shows Up).
The success line is:

```bash
docker logs github-runner 2>&1 | grep "Listening for Jobs"
```

Also confirm the runner shows **Idle** on the GitHub runners page.

### 1.9 Ops quick reference

```bash
docker logs --since 5m github-runner          # recent activity
docker logs github-runner | grep -E "Running job|result:"   # job outcomes
gh api repos/OWNER/REPO/actions/runners       # GitHub-side view (status, ephemeral)
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

# Prevents parallel deploys. Note: a NEWER pending (queued) run REPLACES an
# older pending one — concurrency does not guarantee strict FIFO order of
# every queued run. Fine for typical site deploys; know the semantics.
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
      # - run: pnpm typecheck    # optional gate — add what the project has
      # - run: pnpm test         # optional gate
      - run: pnpm build           # gate

      # ↓↓↓ DEPLOY STEP: pick ONE pattern from Part 3 ↓↓↓
```

Notes:

- **No `cache:` in setup-node.** Its pnpm cache support breaks on bare
  self-hosted containers (`packages field missing or empty`).
- For npm projects substitute `npm ci` / `npm run lint` / `npm run build`.
- **Quality gates are configurable, not one-size-fits-all:** add typecheck /
  unit / integration stages when the project has them. Lint + build is the
  minimum deploy gate.
- **Environment protection (recommended for production):** create a GitHub
  **Environment** named `production` with required reviewers, target it with
  `environment: production` on the job — deploys then wait for approval and
  can carry their own environment-scoped secrets.
- **Action pinning:** major-version tags (`actions/checkout@v4`) suit most
  users; hardened setups pin third-party actions to full commit SHAs for
  supply-chain protection.
- Branch protection: keep the production branch protected; work happens on a
  dev branch and merges in.
- **GitHub-hosted vs self-hosted:** `ubuntu-latest` needs zero maintenance and
  supports every pattern below. Strong default for security: **CI gates on
  GitHub-hosted, deploy job on self-hosted** (`needs:` + `runs-on:`) —
  untrusted code never executes on the production-connected box.

---

## Part 3 — Deploy patterns

### Pattern A — FTPS upload to shared hosting / cPanel (upload-only)

For hosts where the only door is FTP. Uses `basic-ftp` (pure JS, no system
deps). Add as a devDependency (`pnpm add -D basic-ftp`). Full script in this
repo: `scripts/ftp-deploy.mjs`.

```yaml
      - name: Deploy via FTPS (upload-only, never deletes)
        env:
          FTP_SERVER: ${{ secrets.FTP_SERVER }}   # use the hostname ON the TLS cert
          FTP_PORT: ${{ secrets.FTP_PORT }}
          FTP_USER: ${{ secrets.FTP_USER }}
          FTP_PASS: ${{ secrets.FTP_PASS }}
          FTP_TLS_INSECURE: ${{ vars.FTP_TLS_INSECURE }}  # "1" = last resort only
        run: node scripts/ftp-deploy.mjs
```

Certificate handling — **verification is ON by default**:

- cPanel certs usually cover the *server* hostname (`serverXX.web-hosting.com`),
  not `ftp.yourdomain.com` → set `FTP_SERVER` to the hostname that appears on
  the certificate and verification just works.
- `FTP_TLS_INSECURE=1` exists ONLY for providers where that's impossible. It
  disables cert verification: traffic stays encrypted but the server is not
  authenticated (MITM possible). The script logs a loud warning when used.
  Keep the flag in `vars:` (non-secret config) so the choice is visible in
  the repo, not buried in a secret.

Safety properties:

- **No `client.removeDir` / no clearWorkingDir anywhere** — removed-from-build
  files stay on the server (stale hashed asset filenames are harmless; add a
  deliberate cleanup routine later if you truly need one).
- The FTP user should be a **jailed subaccount** scoped to the deploy
  directory, never the primary account.

### Pattern B — Docker image build + registry push, then webhook/SSH redeploy

For containerized apps. Build and push the image, then tell the server to
pull and restart — via webhook (Portainer, Watchtower, Dokploy, Coolify,
custom endpoint) or SSH. The block below is a complete ALTERNATIVE workflow
(replace Part 2's `permissions`/`jobs` with it — don't append blindly):

```yaml
permissions:
  contents: read
  packages: write   # required to push to GHCR

jobs:
  ci-deploy:
    runs-on: ubuntu-latest
    steps:
      # ... gates from Part 2, then:
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
          cache-from: type=gha          # layer cache — GitHub-hosted runners only
          cache-to: type=gha,mode=max
```

(On self-hosted runners without a mounted docker.sock, build-push-action
still works via its own buildx container; `type=gha` cache is GitHub-hosted
only — use a registry cache backend or skip caching elsewhere.)

Then redeploy **by SHA tag** and verify the running container actually uses
that image:

```yaml
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
- **The webhook receiver is part of your attack surface:** it must
  authenticate requests (token), validate the requested image belongs to your
  project (never deploy arbitrary images), and run least-privilege.
- After redeploy, verify on the server:
  `docker inspect --format '{{.Config.Image}}' <container>` must match the
  SHA tag, and the health endpoint must answer.
- `secrets.GITHUB_TOKEN` is automatic per-run; prefer it over a personal
  token for registry pushes, but set `permissions:` explicitly.
- Registry creds for private pulls live in the receiver platform's secret
  store — never baked into images or passed in webhook URLs.

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
- **HTTP 200 only proves the hook accepted the request, not that the deploy
  succeeded.** Follow with real verification (Part 5).

### Pattern D — rsync over SSH

For servers with SSH access. Non-destructive by default (`--delete` omitted —
add it ONLY for a build-output directory that contains nothing else):

```yaml
      - name: Deploy over SSH
        env:
          SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
          KNOWN_HOSTS: ${{ secrets.DEPLOY_KNOWN_HOSTS }}   # pre-verified host keys
        run: |
          install -m 600 /dev/null ~/.ssh/id_ed25519
          printf "%s" "$SSH_KEY" > ~/.ssh/id_ed25519
          printf "%s\n" "$KNOWN_HOSTS" >> ~/.ssh/known_hosts
          rsync -az -e "ssh -o StrictHostKeyChecking=yes" \
            --chmod=D755,F644 dist/ deploy@HOSTNAME:/var/www/app/
```

**Host-key verification — do it from a trusted channel:** `ssh-keyscan` only
records whatever key the network hands it (trust-on-first-use); it does not
prove the key is really your server. The CI-safe approach: SSH to the server
once yourself, check the fingerprint out-of-band (your hosting provider can
confirm it), then store the resulting `known_hosts` line as the
`DEPLOY_KNOWN_HOSTS` secret and inject it as above. `StrictHostKeyChecking=yes`
then FAILS the deploy on any mismatch instead of silently continuing.

Also: use a **dedicated deploy user** (not root), a **restricted key**
(`command=` / `from=` restrictions in `authorized_keys` where possible), and
tight directory permissions on the target.

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

**Verifying a stored secret:** first-line debugging does NOT print or hash
it — check (1) the secret's name and repo/environment scope, (2) that the
workflow actually receives it, (3) the auth error returned by the
destination, without echoing credentials. Hashing inside a temporary debug
workflow (`echo -n "$SECRET" | sha256sum | cut -c1-12`) is a **last resort**
for distinguishing two candidate values without revealing either — compare
hashes locally, never print values, delete the debug workflow afterwards.
This recipe needed it exactly once: a stored secret had a trailing character
(17 chars vs 16 — invisible in GitHub's UI).

---

## Part 5 — Pitfalls and verification

### Pitfalls (observed debugging cases, not universal guarantees)

General (runner + workflow):

| # | Symptom | Root cause | Fix |
|---|---------|-----------|-----|
| P1 | `docker run` exits 0 instantly, empty logs | Runner image has no default entrypoint | Pass explicit `bash -c` command |
| P2 | Runner dies after first job: `Registration was not found or is not medium trust`, then crash-loop `Cannot configure the runner because it is already configured` | `--ephemeral` registration (or `--replace` inheriting it) + non-idempotent start command | Match mode to intent (1.5): ephemeral only with an orchestrator that re-registers; persistent for plain Docker; config only `if [ ! -f .credentials ]` |
| P3 | `TaskAgentSessionConflictException: Conflict` on startup | Stale session from a previous runner with the same name | In our case it self-resolved in ~3 min ("Runner reconnected… Listening for Jobs") — observed, not a documented guarantee. Don't recreate the container mid-conflict |
| P4 | `pnpm preinstall: node: not found` | pnpm setup ran before Node setup (pnpm ≥ 10 installs via npm and needs node) | Put `actions/setup-node` FIRST |
| P5 | `ERROR packages field missing or empty` on install | `pnpm-workspace.yaml` used for config only (no `packages:`) — rejected by pnpm < 10; also setup-node's `cache: pnpm` fails on bare containers | Pin pnpm ≥ 10; drop the cache option |
| P6 | `unexpected argument '--no-save'` | pnpm ≥ 11 removed it | Commit the deploy tool as a devDependency instead |
| P7 | `530 Login authentication failed` despite correct-looking secrets | Secret stored wrong (literal `-` from `--body -`, or trailing char from manual paste) | Re-set via stdin pipe; hash-compare as last resort (Part 4) |

Pattern-specific:

| Pattern | Gotcha |
|---------|--------|
| B | `denied: permission_denied` pushing to GHCR → add `permissions: packages: write` to the workflow |
| B | Server "redeploys" but runs old code → pulled a mutable tag from local cache; deploy by SHA tag and verify the running image |
| C | Hook URL with embedded token leaked via logs → keep in secrets, never echo |
| A | Cert hostname mismatch on cPanel → fix the hostname first; `FTP_TLS_INSECURE=1` only as documented last resort |
| D | `Host key verification failed` in CI → known_hosts not pre-seeded; inject verified hosts (Pattern D) |

### Verification doctrine

Gates passing is not proof of deployment. After a green run, verify the LIVE
target with real requests:

1. **Reachability** — HTTP status of the site / health endpoint (expect 2xx).
2. **Release identity** — fetch the deployed page/bundle and confirm the
   change you just made (new filename hash, new version string); for
   containers, confirm the running image tag matches the deployed SHA.
3. **Asset availability** — at least one hashed asset loads (catches partial
   uploads).
4. **Timeout handling** — every deploy step runs under a timeout; a hung
   deploy must fail the run, not dangle.
5. **Rollback** — know your undo before you need it. Pattern A/D: keep the
   previous build output (`dist-prev/` or a release folder) and re-upload it.
   Pattern B: redeploy the previous SHA tag. Pattern C: re-run the hook on a
   pinned working commit. **If verification fails: roll back FIRST, debug
   second** — especially with client production sites involved.

Only a live-content match means deployed.

---

## Reference documentation

- [Secure use of self-hosted runners](https://docs.github.com/en/actions/reference/security/secure-use)
- [Self-hosted runners reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
- [Runner registration API](https://docs.github.com/en/rest/actions/self-hosted-runners)
- [Workflow syntax (concurrency)](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
