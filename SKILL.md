---
name: github-selfhosted-runner-deploy
description: Use when setting up a GitHub Actions self-hosted runner in Docker and a CI/CD pipeline that builds and deploys a static site to a cPanel/FTP host.
version: 1.1.0
license: MIT
metadata:
  category: devops
  tags: [github-actions, ci-cd, self-hosted-runner, docker, ftp, cpanel, deployment]
---

# GitHub self-hosted runner + FTP deploy pipeline

Complete, battle-tested recipe for: **Dockerized GitHub Actions runner on any
Linux box** + **workflow that lints/builds on push to the production branch
and deploys the build output to a cPanel host over explicit FTPS**.

Design principles baked into this recipe:

- **Upload-only deploys.** The pipeline never deletes remote files — production
  extras (`.htaccess`, manifests, media) can never be wiped by a push.
- **Deploy is gated.** Lint and build must pass before anything uploads.
- **Idempotent runner.** The container survives restarts and reboots.
- **Secrets never touch disk or logs.**

---

## Part 1 — Runner in Docker

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
- Mount `/var/run/docker.sock` ONLY if jobs must build containers — it is
  root-equivalent on the host.

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
# Remove: docker rm -f github-runner, then deregister in GitHub UI or the
# orphan shows offline forever.
```

---

## Part 2 — Workflow (`.github/workflows/deploy.yml`)

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
    runs-on: self-hosted
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

      - name: Deploy build output via FTPS (upload-only)
        env:
          FTP_SERVER: ${{ secrets.FTP_SERVER }}
          FTP_PORT: ${{ secrets.FTP_PORT }}
          FTP_USER: ${{ secrets.FTP_USER }}
          FTP_PASS: ${{ secrets.FTP_PASS }}
        run: node scripts/ftp-deploy.mjs
```

Notes:

- **No `cache:` in setup-node.** Its pnpm cache support breaks on bare
  self-hosted containers (`packages field missing or empty`).
- For npm projects substitute `npm ci` / `npm run lint` / `npm run build`.
- Branch protection: keep the production branch protected; work happens on a
  dev branch and merges in.

---

## Part 3 — Deploy script (`scripts/ftp-deploy.mjs`)

Uses `basic-ftp` (pure JS, no system deps — works in minimal runner
containers). Add it as a devDependency (`pnpm add -D basic-ftp` / `npm i -D basic-ftp`).

```js
import ftp from "basic-ftp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");

for (const k of ["FTP_SERVER", "FTP_USER", "FTP_PASS"]) {
  if (!process.env[k]) { console.error(`Missing env var: ${k}`); process.exit(1); }
}

const client = new ftp.Client(30000);
try {
  await client.access({
    host: process.env.FTP_SERVER,
    port: Number(process.env.FTP_PORT || 21),
    user: process.env.FTP_USER,
    password: process.env.FTP_PASS,
    secure: true,   // explicit FTPS (AUTH TLS)
    secureOptions: { rejectUnauthorized: false }, // cPanel certs rarely match ftp.* hostnames
  });
  console.log("Connected via FTPS. Uploading (upload-only, no deletions)...");
  await client.ensureDir(".");
  await client.uploadFromDir(DIST, ".", { overwrite: true });
  console.log("Deploy complete.");
} catch (err) {
  console.error("Deploy failed:", err);
  process.exit(1);
} finally {
  client.close();
}
```

Safety properties:

- **No `client.removeDir` / no clearWorkingDir anywhere** — removed-from-build
  files stay on the server (stale hashed asset filenames are harmless; add a
  deliberate cleanup routine later if you truly need one).
- `rejectUnauthorized: false` is required for typical cPanel FTPS (cert is for
  the server hostname, e.g. `serverXX.web-hosting.com`, not `ftp.yourdomain.com`).
  Traffic is still encrypted. If your cert matches, set it to `true`.
- The FTP user should be a **jailed subaccount** scoped to the deploy
  directory (cPanel → FTP Accounts → directory), never the primary account.

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

Passwords with special characters: keep them out of shell variables in
command position; pipe them from a local secrets store. Verify a stored
secret without revealing it by hashing it in a temporary `workflow_dispatch`
workflow (`echo -n "$SECRET" | sha256sum | cut -c1-12`) and comparing with
the local hash. **Trailing whitespace kills FTP logins** — a 17-char secret
for a 16-char password looks identical in GitHub's UI.

---

## Pitfalls (each one cost a real debugging cycle)

| # | Symptom | Root cause | Fix |
|---|---------|-----------|-----|
| P1 | `docker run` exits 0 instantly, empty logs | Image has no default entrypoint | Pass explicit `bash -c` command |
| P2 | Runner dies after first job: `Registration was not found or is not medium trust`, then crash-loop `Cannot configure the runner because it is already configured` | `--ephemeral` registration (or `--replace` inheriting it) + non-idempotent start command | Fresh registration without ephemeral; config only `if [ ! -f .credentials ]` |
| P3 | `TaskAgentSessionConflictException: Conflict` on startup | Stale session from a previous runner with the same name | Self-resolves in ~3 min ("Runner reconnected… Listening for Jobs"). Don't recreate the container |
| P4 | `pnpm preinstall: node: not found` | pnpm setup ran before Node setup (pnpm ≥ 10 installs via npm and needs node) | Put `actions/setup-node` FIRST |
| P5 | `ERROR packages field missing or empty` on install | `pnpm-workspace.yaml` used for config only (no `packages:`) — rejected by pnpm < 10; also setup-node's `cache: pnpm` fails on bare containers | Pin pnpm ≥ 10; drop the cache option |
| P6 | `unexpected argument '--no-save'` | pnpm ≥ 11 removed it | Commit the deploy tool as a devDependency instead |
| P7 | `530 Login authentication failed` despite correct-looking secrets | Secret stored wrong (literal `-` from `--body -`, or trailing char from manual paste) | Re-set via stdin pipe; verify by hash in a debug workflow |

## Verification doctrine

Gates passing is not proof of deployment. After a green run, check the LIVE
site: fetch the deployed page/bundle and grep for the change you just made
(new filename hash, new string). Only a live-content match means deployed.
