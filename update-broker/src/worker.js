// TwinMS update broker — Cloudflare Worker.
//
// The app authenticates with the shared key in the X-Update-Key header, then:
//
//   App updates (feed = twinms-releases):
//     GET /<channel>.yml   -> update manifest ("latest" = newest full release,
//                             "dev" = newest prerelease)
//     GET /<filename>      -> 302 to a short-lived signed URL for that installer asset
//
//   DB snapshot (feed = twinms-backend, first-run seeding):
//     GET /snapshot/manifest -> { tag, assets:[{name,size}] } for the newest
//                               release-* that carries db-backup* assets
//     GET /snapshot/<file>   -> 302 to a short-lived signed URL for that asset
//
// The GitHub token lives ONLY here (Cloudflare secret) — never in the app.
//
// Secrets (wrangler secret put):
//   BROKER_KEY    — shared key the app must send in X-Update-Key
//   GITHUB_TOKEN  — fine-grained PAT, Contents:read on BOTH
//                   Horde-Core/twinms-releases AND Horde-Core/twinms-backend

const OWNER = "Horde-Core";
const RELEASES_REPO = "twinms-releases"; // app installers + *.yml
const SNAPSHOT_REPO = "twinms-backend"; // db-backup* snapshot assets
const UA = "twinms-update-broker";

function ghHeaders(env, accept) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": UA,
  };
}

// Newest-first list of non-draft releases for a repo.
async function listReleases(env, repo) {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${repo}/releases?per_page=30`,
    { headers: ghHeaders(env, "application/vnd.github+json") },
  );
  if (!res.ok) throw new Error(`releases list (${repo}) ${res.status}`);
  return (await res.json()).filter((r) => !r.draft);
}

// Resolve a release asset (by its API url) to its short-lived signed CDN url.
async function signedAssetUrl(env, assetApiUrl) {
  const res = await fetch(assetApiUrl, {
    redirect: "manual",
    headers: ghHeaders(env, "application/octet-stream"),
  });
  return res.headers.get("location");
}

// ── App update feed (twinms-releases) ────────────────────────────────────────

// "latest" -> newest full release; anything else -> newest prerelease.
function pickChannelRelease(releases, channel) {
  const wantPrerelease = channel !== "latest";
  return releases.find((r) => !!r.prerelease === wantPrerelease) || null;
}

async function handleYml(env, channel) {
  const releases = await listReleases(env, RELEASES_REPO);
  const rel = pickChannelRelease(releases, channel);
  if (!rel) return new Response(`no release for channel "${channel}"`, { status: 404 });

  // electron-builder may name the manifest <channel>.yml or latest.yml — be defensive.
  const asset =
    rel.assets.find((a) => a.name === `${channel}.yml`) ||
    rel.assets.find((a) => a.name === "latest.yml") ||
    rel.assets.find((a) => a.name.endsWith(".yml"));
  if (!asset) return new Response("no .yml asset in release", { status: 404 });

  const signed = await signedAssetUrl(env, asset.url);
  if (!signed) return new Response("could not resolve yml url", { status: 502 });
  // Fetch the manifest bytes ourselves (no auth header to the signed CDN url —
  // it carries its own token and rejects a second auth mechanism).
  const ymlRes = await fetch(signed, { headers: { "User-Agent": UA } });
  if (!ymlRes.ok) return new Response("yml fetch failed", { status: 502 });
  return new Response(await ymlRes.text(), {
    status: 200,
    headers: { "content-type": "text/yaml; charset=utf-8" },
  });
}

async function handleInstaller(env, filename) {
  const releases = await listReleases(env, RELEASES_REPO);
  let asset = null;
  for (const rel of releases) {
    const found = rel.assets.find((a) => a.name === filename);
    if (found) {
      asset = found;
      break;
    }
  }
  if (!asset) return new Response(`asset not found: ${filename}`, { status: 404 });
  const signed = await signedAssetUrl(env, asset.url);
  if (!signed) return new Response("could not resolve asset url", { status: 502 });
  return Response.redirect(signed, 302);
}

// ── DB snapshot feed (twinms-backend) ────────────────────────────────────────

// Newest release-* that carries db-backup* assets (mirrors snapshot-fetch.js).
async function newestSnapshotRelease(env) {
  const releases = await listReleases(env, SNAPSHOT_REPO);
  return (
    releases.find(
      (r) =>
        /^release-/.test(r.tag_name || "") &&
        (r.assets || []).some((a) => /^db-backup.*\.zip$/i.test(a.name)),
    ) || null
  );
}

async function handleSnapshotManifest(env) {
  const rel = await newestSnapshotRelease(env);
  if (!rel) return new Response("no snapshot release found", { status: 404 });
  const assets = rel.assets
    .filter((a) => /^db-backup.*\.zip$/i.test(a.name))
    .map((a) => ({ name: a.name, size: a.size }));
  return Response.json({ tag: rel.tag_name, assets });
}

async function handleSnapshotAsset(env, filename) {
  // Scope to the same newest release the manifest reports — db-backup names repeat
  // across releases, so "by name across all releases" would be ambiguous.
  const rel = await newestSnapshotRelease(env);
  if (!rel) return new Response("no snapshot release found", { status: 404 });
  const asset = rel.assets.find((a) => a.name === filename);
  if (!asset) return new Response(`snapshot asset not found: ${filename}`, { status: 404 });
  const signed = await signedAssetUrl(env, asset.url);
  if (!signed) return new Response("could not resolve snapshot url", { status: 502 });
  return Response.redirect(signed, 302);
}

export default {
  async fetch(request, env) {
    // Auth — shared client key.
    const key = (request.headers.get("X-Update-Key") || "").trim();
    const expected = (env.BROKER_KEY || "").trim();
    if (!expected) return new Response("broker key not configured", { status: 401 });
    if (key !== expected) return new Response("bad key", { status: 401 });
    if (!env.GITHUB_TOKEN) return new Response("github token not configured", { status: 500 });

    const pathname = decodeURIComponent(new URL(request.url).pathname);

    try {
      if (pathname === "/snapshot/manifest") return await handleSnapshotManifest(env);
      if (pathname.startsWith("/snapshot/")) {
        return await handleSnapshotAsset(env, pathname.slice("/snapshot/".length));
      }

      const name = pathname.slice(1);
      if (!name) return new Response("twinms update broker ok", { status: 200 });
      if (name.endsWith(".yml")) return await handleYml(env, name.slice(0, -4));
      return await handleInstaller(env, name);
    } catch (err) {
      return new Response(`broker error: ${err?.message || err}`, { status: 502 });
    }
  },
};
