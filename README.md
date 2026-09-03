# site-toolkit

Shared deploy and drift-check tooling for Nathan LaValley's static and PHP
sites on shared hosting. One copy of the logic; every site repo calls it.

This repo is public on purpose and contains **no host, path, account ID or
credential**. All of that lives in each private site repo's `site.config.json`
and GitHub secrets. If you are adding something here and it names a server,
it belongs in a config file, not in this repo.

## What a site repo needs

**1. `site.config.json`** at the repo root (or one per site in a monorepo):

```json
{
  "name": "example",
  "label": "example.com",
  "transport": "ftp",
  "source": "site",
  "remote": "public_html",
  "deletes": false,
  "ignore": ["*.mov"],
  "server_owned": ["uploads/", "data/site-data.json"],
  "secrets": ["config.php"],
  "credentials": {
    "env_file": "~/path/to/example.env",
    "host": "EXAMPLE_FTP_HOST",
    "user": "EXAMPLE_FTP_USER",
    "password": "EXAMPLE_FTP_PASSWORD"
  },
  "alerts": { "ntfy_secret": "NTFY_URL" }
}
```

Three buckets, declared once, read by both the deploy and the drift check:

| Bucket | Deployed | Deleted by `--delete` | Flagged as drift |
|---|---|---|---|
| source (everything else) | yes | n/a | yes |
| `ignore` | no | no | no |
| `server_owned` | no | no | no |
| `secrets` | no | no | no |

Add `"tls": true` for a host that requires explicit FTPS.

`credentials` holds the **names** of the variables that carry each value.
Locally they are read from `env_file`; in CI they come from repository secrets
of the same names. `remote_dir`, `port` and `protocol` may also be given as
variable names.

For a site deployed by **rsync over SSH** instead, set `"transport": "rsync"`,
make `remote` the `user@host:path/` target, drop `credentials`, and add:

```json
"ssh": { "port": 65002, "key": "~/.ssh/deploy_key", "key_secret": "HOSTINGER_SSH_KEY" }
```

`key` is the local key file; `key_secret` names the repository secret holding
the private key for CI. The caller uses `deploy-rsync.yml` instead of
`deploy-ftp.yml`. The drift check works the same way for both.

**2. A caller workflow** for deploys, about fifteen lines:

```yaml
name: Deploy
on:
  push:
    branches: [main]
    paths: ['site/**', 'site.config.json', '.github/workflows/deploy.yml']
  workflow_dispatch:
    inputs:
      skip_drift_check: { type: boolean, default: false }
concurrency: { group: deploy, cancel-in-progress: false }
jobs:
  deploy:
    uses: nathanmlavalley/site-toolkit/.github/workflows/deploy-ftp.yml@v1
    with:
      config: site.config.json
      skip_drift_check: ${{ inputs.skip_drift_check || false }}
    secrets: inherit
```

**3. A caller workflow** for the daily drift sweep. See `examples/`.

**4. Repository secrets** with the names the config uses.

## Callers in another organization

`secrets: inherit` only works when the caller and this repo share an owner.
A repo in a different organization maps its secrets onto the generic names
the workflows declare:

```yaml
    uses: nathanmlavalley/site-toolkit/.github/workflows/drift-check.yml@v1.7
    with:
      configs: site.config.json
    secrets:
      FTP_HOST: ${{ secrets.STAGING_FTP_HOST }}
      FTP_USER: ${{ secrets.STAGING_FTP_USER }}
      FTP_PASSWORD: ${{ secrets.STAGING_FTP_PASSWORD }}
```

The scripts use the config's credential names first and fall back to these.
One generic set per job, so a cross-org drift sweep covers one site per call.

## Pin to a tag, never `@main`

This repo runs with each caller's credentials. A caller that references
`@main` would execute whatever the latest commit here is, so one bad or
malicious commit reaches every site at once. Callers reference `@v1` and this
repo moves the `v1` tag deliberately.

## Local use

Clone to `~/site-toolkit`. On a Mac also `brew install lftp rsync`: the
built-in openrsync misreports checksums, which shows up as false drift. From
inside any site repo:

```bash
node ~/site-toolkit/scripts/live-check.js            # every site.config.json here
node ~/site-toolkit/scripts/live-check.js --deep     # exact hashes
node ~/site-toolkit/scripts/live-check.js --cached   # instant, for hooks
bash ~/site-toolkit/scripts/deploy-ftp.sh --config site.config.json --dry-run
bash ~/site-toolkit/scripts/guard.sh --config site.config.json   # preflight for a manual deploy
```

`live-check.js` exits 0 clean, 1 drift, 2 could not check. Live content that
matches an older commit is reported as undeployed work and does not fail; live
content that matches nothing in git does.

## Layout

```
scripts/config.js        resolve one site.config.json into shell variables
scripts/deploy-ftp.sh    lftp mirror driven by the config
scripts/deploy-rsync.sh  rsync-over-ssh mirror driven by the config
scripts/live-check.js    drift checker
scripts/guard.sh         dirty/behind/ahead preflight plus drift check
.github/workflows/       the reusable workflows
examples/                caller workflows and a config
```
