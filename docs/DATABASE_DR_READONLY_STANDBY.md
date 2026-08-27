# Database Backup and Read-Only Standby Plan

Last verified: 2026-08-27 (Asia/Seoul)

## Goal

- `.110` and `.111` remain the only writable database servers.
- `.40` keeps off-host backups and read-only PostgreSQL standby instances.
- During a primary outage, applications may read from `.40`, but writes fail closed.
- `.40` is never promoted. After the primary returns, replication resumes in the
  original direction, so reverse synchronization is not required.

This is a read-only disaster-recovery design. It is not automatic multi-primary
HA.

## Verified Primary Layout

| Primary | Database | Container | PostgreSQL | Backup stanza |
|---|---|---|---|---|
| `192.168.33.110` | Damoa | `damoa-db` | 15.19 | `damoa` |
| `192.168.33.111` | Hub | `hub-db` | 15.19 | `hub111` |
| `192.168.33.111` | Title Clash | `tc-db` | 15.19 | `tc111` |
| `192.168.33.111` | Predict Clash | `pc-db` | 15.19 | `pc111` |
| `192.168.33.111` | Claw Clash | `cc-db` | 15.19 | `cc111` |

All five primaries were verified with:

```text
wal_level=replica
max_wal_senders=10
max_replication_slots=10
hot_standby=on
archive_mode=on
archive_command=pgbackrest ... archive-push
```

## Current Backup Path

All stanzas use pgBackRest over SFTP and write to:

```text
appback@192.168.33.40:/home/appback/backup/pgbackrest/repo
```

Schedules:

| Primary | Full | Differential | Continuous WAL |
|---|---|---|---|
| `.110` Damoa | Sunday 18:00 UTC | Mon-Sat 18:00 UTC | yes |
| `.111` four DBs | Sunday 17:00 UTC | Mon-Sat 17:00 UTC | yes |

On 2026-08-27, all five stanzas had a successful 2026-08-23 full backup,
successful differential backups through 2026-08-26, and WAL files arriving on
2026-08-27. The repository contained only these active stanzas:

```text
damoa
hub111
tc111
pc111
cc111
```

Old `.110` stanzas named `hub`, `tc`, `pc`, and `cc` were removed after the
services moved to `.111`.

## Accumulation Audit: 2026-08-27

The repository did not contain unknown or orphan pgBackRest stanzas. The active
repository directories were limited to `damoa`, `hub111`, `tc111`, `pc111`, and
`cc111`. The non-database backup sets were also small:

```text
appback-minio current + history: about 1.4 GB
damoa-media current + history: about 3.9 GB
```

The following unresolved accumulation risks were found.

### Damoa WAL growth

The `damoa` archive occupied about 187 GB and was growing by approximately
37-60 GB per day. PostgreSQL reported about 909 GB of WAL generated since the
statistics reset on 2026-08-24. This was real WAL, not duplicate archive files.

The write workload repeatedly updates or replaces large portions of several
catalog tables. PostgreSQL was also configured with `max_wal_size=1GB`,
`checkpoint_timeout=5min`, `wal_compression=off`, and had 1,746 requested
checkpoints during the sampled period. Full-page images therefore account for
a significant part of the WAL volume.

The `.110` data directory also retained about 32.6 GB in `pg_wal` because
`wal_keep_size=32GB`, even though no replication slot or live standby existed.

### Stale bind-mounted pgBackRest configuration

The host path `/opt/appback/pgbackrest/config/pgbackrest.conf` had already been
replaced with the Damoa-only retention policy, but `damoa-db` still had the old
unlinked inode bind-mounted. The running container therefore continued to use:

```text
repo1-retention-full=4
repo1-retention-diff=14
archive-async=y
```

instead of the host file's intended `full=1`, `diff=6`, explicit archive
retention, and Damoa-only stanza. Replacing a bind-mounted file atomically does
not update the inode already mounted into a running container. The database
container must be recreated or the mounted inode must otherwise be updated and
verified before relying on the new policy.

At the observed WAL rate, the `.40` internal disk's approximately 119 GB free
space may be exhausted before the next weekly full backup. A successful new
full backup will not expire the old chain while the running container still
uses retention count 4.

### Backups without bounded retention

- `.40` `appback-minio/history` had seven daily change sets but no explicit
  age/count cleanup in the backup script or user cron.
- `.111` retained about 18 GB of Damoa pre-migration dumps even though Damoa now
  runs on `.110`.
- `.111` retained about 3.6 GB of deployment rollback dumps and about 995 MB of
  legacy Title Clash originals without a general retention job.
- `.40` retained about 3.2 GB under `usb-enclosure-safety-copy`. Keep it until
  the old 4 TB MinIO disk is mounted read-only and verified, then reassess it.
- `.40` RemoteAgent workspaces consumed about 21 GB. The two large workspaces
  were still referenced by sessions, so they were not orphans and must not be
  removed automatically.

### Required correction order

1. Make the running `damoa-db` consume the current pgBackRest configuration and
   verify the effective settings from inside the container.
2. Run and verify a new Damoa full backup, then confirm expiration reclaimed the
   previous backup chain and its WAL.
3. Add disk thresholds and projected-days-to-full monitoring for the `.40`
   repository.
4. Reduce Damoa WAL at the source by reviewing the catalog synchronization
   write pattern and PostgreSQL checkpoint/WAL settings.
5. Reduce `wal_keep_size` while no streaming standby exists; select a new value
   as part of standby deployment rather than retaining an unused 32 GB.
6. Add explicit retention to MinIO history and deployment rollback dumps.
7. Remove `.111` Damoa migration dumps only after the `.110` restore path is
   independently verified.

## Corrections Applied: 2026-08-27

The accumulation incident was corrected in the following order.

1. Recreated only `damoa-db` so its bind-mounted pgBackRest configuration uses
   the current host file. The effective container configuration is now strict
   SFTP host-key verification with SHA-256, `full=1`, `diff=6`, `archive=1`,
   and synchronous archive submission.
2. Added all verified `.40` SSH host keys to the pinned `known_hosts` file and
   proved a strict pgBackRest repository connection before running a backup.
3. Created and verified full backup `20260827-043735F`. Expiration removed the
   superseded Damoa backup chain and its WAL. The `.40` pgBackRest repository
   fell from about 229 GB to 18 GB, and root filesystem use fell from 74% to
   26%.
4. Applied these reloadable Damoa PostgreSQL settings:

   ```text
   wal_keep_size=1GB
   wal_compression=pglz
   max_wal_size=8GB
   checkpoint_timeout=15min
   ```

   A PostgreSQL checkpoint then reduced `.110` `pg_wal` from about 32.6 GB to
   about 2 GB. No WAL file was deleted manually. The `.110` root filesystem is
   now 13% used.
5. Repaired the isolated Damoa restore verifier and completed an actual
   restore, WAL replay, read-only query, and shutdown test for the new full
   backup. The verified database system ID was `7666642961956692002`.
6. Removed 18 GB of obsolete pre-migration Damoa dumps from `.111` after the
   restore test passed. Also removed about 1.5 GB of deployment rollback
   entries older than 35 days. The `.111` root filesystem fell from 64% to 57%
   used.
7. Installed bounded 35-day cleanup jobs for `.111` deployment rollback
   entries and `.40` Damoa media and Appback MinIO history. The shared cleanup
   command is dry-run by default, only considers immediate children of an
   explicitly supplied root, and requires `--apply` before deletion.

Continuous Damoa WAL archiving was observed advancing after the backup and
expiration. The active pgBackRest stanza set remains exactly `damoa`, `hub111`,
`tc111`, `pc111`, and `cc111`.

The database tuning mitigates storage growth but does not remove its source.
Damoa catalog synchronization still performs unusually high update/replace
volume across campaign route, media, coordinate, and source tables. That
application write amplification requires a separate code and query review.

The following data was intentionally retained:

- `.111` legacy Title Clash originals, about 995 MB, until ownership and
  duplication are independently verified.
- `.40` `usb-enclosure-safety-copy`, about 3.2 GB, until the preserved 4 TB
  MinIO disk is mounted read-only and compared.
- `.40` RemoteAgent workspaces referenced by active session state. They are not
  orphan workspaces and must not be deleted by a backup cleanup job.

## Important Limitation

The pgBackRest repository is recovery material, not a queryable standby. A
PostgreSQL process cannot serve reads directly from the repository. Read-only
outage service requires five restored PostgreSQL instances on `.40` that keep
replaying WAL.

## Target Layout on `.40`

Use one PostgreSQL 15 standby per source database. Assign separate ports and
data directories. Keep the application-facing endpoints separate:

```text
write endpoint -> primary only (.110 or .111)
read endpoint  -> primary normally, .40 standby during an outage
```

Standby requirements:

- `hot_standby=on`
- recovery remains active
- no promotion trigger and no automatic failover manager
- application credentials on `.40` receive read-only privileges
- network rules allow application reads but block unintended administrative
  writes
- monitoring checks replay delay, receive/replay LSN, last replay time, disk
  space, and restore errors

Recommended replication method:

1. Bootstrap each standby from its pgBackRest backup.
2. Use asynchronous physical streaming replication from the primary.
3. Keep pgBackRest WAL restore configured as a gap-recovery fallback.
4. If streaming is interrupted, continue replaying archived WAL when available.

## Dual-Bay Allocation

The dual-bay enclosure currently attached to `.40` contains:

| Device | Size | Label | Current state |
|---|---:|---|---|
| Toshiba | 4 TB | `MINIO4T` | unmounted, preserves the previous MinIO data |
| WDC | 2 TB | `STORAGE2T` | unmounted |

Recommended allocation after data validation:

- 2 TB: PostgreSQL standby data directories for all five databases.
- 4 TB: pgBackRest repository and MinIO read-only replica data.

The five PostgreSQL datasets currently total well below 200 GB, so the 2 TB
disk has ample capacity. The two disks share one USB bridge and power source;
they are not independent backup copies. The writable primaries on `.110` and
`.111` remain the independent source copies.

Do not reformat or repurpose the 4 TB disk until its old MinIO data has been
mounted read-only, inventoried, and compared with the active `.110` MinIO.

## Implementation Order

1. Mount the 4 TB disk read-only on `.40` and verify the preserved MinIO data.
2. Mount and endurance-test the 2 TB disk, then create standby data paths.
3. Move the pgBackRest repository to the 4 TB disk with a verified maintenance
   window, preserving the existing repository path with a bind mount.
4. Bootstrap one low-risk standby first, recommended `pc111`.
5. Verify read-only SQL, WAL replay, reconnect, restart, and primary recovery.
6. Repeat for `tc111`, `hub111`, `cc111`, then `damoa`.
7. Add separate read endpoints and prove that writes to `.40` fail.
8. Test a primary outage without promoting `.40`, then restore the primary and
   verify replication resumes.
9. Add monitoring and a periodic restore/read test. A backup is not considered
   verified solely because archive files exist.

## Service Continuity Boundary

A read-only database does not keep an application available if the application
server itself is down. In particular, a complete `.110` outage also removes the
Damoa API unless a read-only application instance exists on another host. The
same rule applies to services hosted on `.111`.

MinIO follows the same policy independently:

- writes go only to `.110`
- `.110` replicates one way to an independent `.40` MinIO
- `.40` uses read-only application credentials
- `.40` is not written to during a `.110` outage

## Container DNS Continuity

Recreating MinIO may assign it a different Docker network address. A healthy
MinIO container and a healthy edge container do not prove that the edge is
using the current address: an Nginx worker can retain the address resolved when
it started and continue returning 502 for uncached objects.

The `.110` edge configuration therefore uses Docker DNS `127.0.0.11` with
bounded re-resolution for both application upstreams:

```nginx
resolver 127.0.0.11 valid=10s ipv6=off;

upstream damoa_api_upstream {
    zone damoa_api_upstream 64k;
    server damoa-api:3100 resolve;
}

upstream damoa_media_upstream {
    zone damoa_media_upstream 64k;
    server appback-minio:9000 resolve;
}
```

`/home/appback/deploy/damoa/media-edge.conf` is mounted read-only at
`/etc/nginx/conf.d/default.conf`. After recreating either MinIO or the Damoa
API, validation must request at least one known uncached media object through
the edge and confirm a 200 response. Container health checks alone are not an
acceptable continuity test.

## Validation Evidence Required

For every standby:

```text
pg_is_in_recovery() = true
transaction_read_only = on for application access
receive/replay LSN is advancing
replay delay is within the accepted limit
write test fails
read query succeeds
restart preserves recovery mode
primary outage read test succeeds
primary recovery resumes replication without reverse sync
```
