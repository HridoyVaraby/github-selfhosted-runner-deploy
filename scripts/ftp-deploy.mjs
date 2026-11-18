/**
 * Upload-only FTPS deploy script (works in minimal self-hosted runner containers).
 * Uploads the contents of a build directory to an FTP root. NEVER deletes remote files.
 * Requires: basic-ftp (devDependency).
 *
 * Env vars: FTP_SERVER, FTP_PORT (optional, default 21), FTP_USER, FTP_PASS.
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

const client = new ftp.Client(30000);

try {
  await client.access({
    host: process.env.FTP_SERVER,
    port: Number(process.env.FTP_PORT || 21),
    user: process.env.FTP_USER,
    password: process.env.FTP_PASS,
    secure: true, // explicit FTPS (AUTH TLS)
    // cPanel certs usually cover the server hostname, not ftp.yourdomain.com.
    // Traffic stays encrypted; set true if your cert matches.
    secureOptions: { rejectUnauthorized: false },
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
