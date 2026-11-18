#!/usr/bin/env node
/**
 * Upload-only FTPS deploy script (works in minimal self-hosted runner containers).
 * Uploads the contents of a build directory to an FTP root. NEVER deletes remote files.
 * Requires: basic-ftp (devDependency).
 *
 * Env vars:
 *   FTP_SERVER   (required) — use the hostname that appears ON the TLS certificate
 *                            (cPanel: often serverXX.web-hosting.com, not ftp.yourdomain.com)
 *   FTP_PORT     (optional, default 21)
 *   FTP_USER     (required) — a jailed FTP subaccount scoped to the deploy directory
 *   FTP_PASS     (required)
 *   FTP_TLS_INSECURE  (optional) — set to "1" ONLY if the server presents an
 *                            invalid/mismatched certificate you cannot avoid by
 *                            fixing the hostname. Disables certificate verification:
 *                            traffic stays encrypted but the server is not
 *                            authenticated (MITM possible). Log a warning.
 *
 * Change BUILD_DIR below if your build output is not ./dist.
 */
import ftp from "basic-ftp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUILD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");

for (const k of ["FTP_SERVER", "FTP_USER", "FTP_PASS"]) {
  if (!process.env[k]) {
    console.error(`Missing env var: ${k}`);
    process.exit(1);
  }
}

const insecure = process.env.FTP_TLS_INSECURE === "1";
if (insecure) {
  console.warn(
    "WARNING: FTP_TLS_INSECURE=1 — TLS certificate verification DISABLED. " +
    "Traffic is encrypted but the server is NOT authenticated (MITM possible).",
  );
}

const client = new ftp.Client(30000);

try {
  await client.access({
    host: process.env.FTP_SERVER,
    port: Number(process.env.FTP_PORT || 21),
    user: process.env.FTP_USER,
    password: process.env.FTP_PASS,
    secure: true, // explicit FTPS (AUTH TLS)
    secureOptions: { rejectUnauthorized: !insecure },
  });
  console.log("Connected via FTPS. Uploading (upload-only, no deletions)...");
  await client.ensureDir(".");
  await client.uploadFromDir(BUILD_DIR, ".", { overwrite: true });
  console.log("Deploy complete.");
} catch (err) {
  console.error("Deploy failed:", err);
  process.exit(1);
} finally {
  client.close();
}
