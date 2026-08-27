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
