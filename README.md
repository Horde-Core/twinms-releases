# TwinMS Releases

The release / orchestration repo for TwinMS. Two kinds of GitHub Releases live here:

- **Backend artifacts** — `release-<timestamp>` **prereleases** holding `backend.zip` + `db-backup.zip`, published by `twinms-backend`'s CI. These are *build inputs*; `electron-updater` ignores prereleases, so clients never update from them.
- **Client installers** — `v<semver>` releases holding the `.exe` + `latest.yml` + `.blockmap`, published by the **Build installer** workflow below. This is the feed installed clients auto-update from.

> Keeping backend artifacts as prereleases is what keeps the two apart — see `prerelease: true` on the backend's publish step.

## Build installer (orchestrator)

`.github/workflows/build-installer.yml` — **manual** (`workflow_dispatch`) for now. It:

1. Checks out `twinms-frontend` (it owns the Electron shell + packaging config).
2. Downloads the newest backend prerelease (`backend.zip` + `db-backup.zip`).
3. Fetches the Mongo/Node/VC++ vendor binaries (`setup-local-stack.ps1 -BinariesOnly`).
4. Builds the UI (`next build`), assembles the stack, and runs `electron-builder --publish` → a client installer release.

### Required secret
- **`ORCHESTRATOR_TOKEN`** — a fine-grained PAT with **Contents: read** on `Horde-Core/twinms-frontend` and **Contents: read & write** on `Horde-Core/twinms-releases`.

### Run it
Actions → **Build installer** → **Run workflow**. Optionally set a `version` (e.g. `0.2.0`) — bump it each run so installed apps see a newer version to update to.
