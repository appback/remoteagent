# Server 26 Ubuntu Migration Handover

## 1. Purpose

This document hands over the conversion of server 26 from the legacy
RHEL/SQream/backup host into the primary production application server.

Target role:

- public address: `125.132.17.159`
- internal address: `192.168.33.26`
- SSH account before reinstall: `ospadmin`
- proposed hostname after reinstall: `appback-prod`
- proposed OS: a clean Ubuntu LTS installation
- primary workload: production application containers
- external disk: backup-only storage

The internal address should remain `192.168.33.26`. There is no operational
benefit in changing it again, and retaining it reduces changes to NAT,
firewall, SSH, monitoring, and deployment configuration.

This document does not authorize destructive work. Formatting or reinstalling
the OS disk requires explicit user approval after the backup and restore gates
below pass.

## 2. Current Verified State

Verified on `2026-08-13` through:

```bash
ssh ospadmin@192.168.33.26
```

### Host and network

- current OS: Red Hat Enterprise Linux 8.9
- current hostname: `scailium-node`
- active interface: `enp0s31f6`
- active address: `192.168.33.26/24`
- current wired MAC: `1c:1b:0d:90:8b:ce`
- former Wi-Fi profile: `DAONEWF5G`
- former Wi-Fi interface: `wlp0s20f0u5`
- former cloned Wi-Fi MAC: `00:15:5D:BC:FA:34`
- DNS and outbound Telegram API access are currently working

Confirm that the router maps public address `125.132.17.159` to this host
before production cutover. Do not assume that the public address is configured
directly on the Linux interface.

### Disks

| Device | Size | Filesystem | Current role |
| --- | ---: | --- | --- |
| `/dev/sdc` | 238.5GB | RHEL LVM/XFS | Current OS disk; intended Ubuntu install target |
| `/dev/sda2` | 3.7TB | XFS, label `RA_BACKUP_4T` | Mounted at `/mnt/backup`; preserve |
| `/dev/sdb1` | 1.8TB | NTFS | Currently unmounted; ownership and purpose must be confirmed |

Current filesystem pressure:

- `/`: 207GB total, 185GB used, 90%
- `/home`: 23GB total, 14GB used, 63%
- `/mnt/backup`: 3.7TB total, 73GB used, 2%

Physically disconnect both `/dev/sda` and `/dev/sdb` before installing Ubuntu.
Only `/dev/sdc` may be selected by the installer.

## 3. Critical Backup Finding

`/mnt/backup/pg` exists but is currently empty. The PostgreSQL dumps that must
be preserved are still on the OS-side storage under `/data/cluster`.

Verified dump inventory:

| Source | Size | Dump count | Latest verified dump |
| --- | ---: | ---: | --- |
| `/data/cluster/appback-hub-backups` | 8.7GB | 141 | `2026-08-09 06:17 KST`, about 90MB |
| `/data/cluster/grid-clash-backups` | 30GB | 122 | `2026-08-09 07:49 KST`, about 409MB |
| `/data/cluster/damoa-backups` | 16GB | 4 | `2026-08-09 02:48 KST`, about 4.3GB |

These dumps predate the current boot and are not yet confirmed as complete or
restorable. File existence is not a restore test.

The external disk currently contains media backup data instead:

- `/mnt/backup/remoteagent/damoa-media/current`: about 2.3GB
- `/mnt/backup/remoteagent/damoa-media/history`: about 44GB
- `/mnt/backup/remoteagent/damoa-media/restore-tests`: empty

### Mandatory copy stage

Copy the database backup trees to the external disk without deleting either
source or destination data:

```bash
sudo mkdir -p /mnt/backup/pg
sudo rsync -aH --info=progress2 \
  /data/cluster/appback-hub-backups/ \
  /mnt/backup/pg/appback-hub-backups/
sudo rsync -aH --info=progress2 \
  /data/cluster/grid-clash-backups/ \
  /mnt/backup/pg/grid-clash-backups/
sudo rsync -aH --info=progress2 \
  /data/cluster/damoa-backups/ \
  /mnt/backup/pg/damoa-backups/
```

Generate a manifest after the copy:

```bash
cd /mnt/backup/pg
find . -type f -name '*.dump' -print0 \
  | sort -z \
  | xargs -0 sha256sum \
  > SHA256SUMS
sha256sum -c SHA256SUMS
```

The copy stage is complete only when file counts, total sizes, and SHA-256
verification match the source inventory.

### Mandatory restore stage

For each service, restore the newest selected dump into an isolated PostgreSQL
instance and record:

- PostgreSQL version used for restore
- `pg_restore` exit status
- restored database size
- schema count and expected key tables
- basic row-count checks agreed with the service owner
- application health check against the restored database where possible

Store the evidence under:

```text
/mnt/backup/pg/restore-evidence/<service>/<timestamp>/
```

Do not reinstall the OS until all required databases have a successful restore
record. If the latest dump fails, stop and report it rather than silently using
an older dump.

## 4. Current RemoteAgent State

RemoteAgent was repaired during the network investigation:

- package: `appback-remoteagent@0.21.1`
- runtime: user `systemd` service
- unit: `~/.config/systemd/user/remoteagent.service`
- state: active and enabled
- linger: enabled for `ospadmin`
- providers detected: Codex
- configured Telegram bots observed:
  - `@bot26pcbotbotbot_bot`
  - `@ayeTemail_bot`

Runtime data is under:

```text
/home/ospadmin/.remoteagent
```

The Secret Store contains operational credentials. Secret values must never be
written into this repository or the handover report. Export it through the
RemoteAgent secret migration procedure and store the encrypted archive on the
external disk with mode `600`.

Also preserve:

- `~/.ssh/authorized_keys`
- the current RemoteAgent `.env`
- session/state data only if existing Telegram sessions must be resumed
- `/home/ospadmin/crontab.before-network-fix-20260813-094632`

Reinstall RemoteAgent from npm after Ubuntu is ready. Do not copy the old npm
global package directory from RHEL.

## 5. SQream and Scheduled Jobs

SQream is not healthy and must not be treated as a running database.

Actions already completed:

- active SQream configuration IPs were changed from `192.168.0.26` to
  `192.168.33.26`
- overlapping market/strategy processes were terminated
- the affected market cron lines were commented with `TEMP_NETWORK_FIX`
- the original crontab was backed up at the path recorded above

Current SQream state:

- metadata server is reachable on port `3105`
- server picker is reachable on port `3108`
- active SQream workers: `0`
- all five workers connect to metadata and then exit with:

```text
Error: mismatch in mac address validation Please contact SQream support.
```

The license appears tied to the former Wi-Fi MAC. Reissuing the license for the
wired MAC would be required if SQream were retained. The target server role no
longer requires SQream, so the recommended migration is to preserve only data
that has an explicit owner and then omit SQream from the new Ubuntu build.

Do not resume the paused market cron jobs on the current host. Decide separately
whether those jobs are retired or moved to a dedicated analytics host.

## 6. Recommended Migration Plan

### Phase A: inventory and freeze

1. Confirm the application services that will run on the new production host.
2. Confirm whether all three PostgreSQL backup families must be retained.
3. Confirm the owner and disposition of `/dev/sdb1`.
4. Record router NAT, port forwarding, firewall, DNS, and TLS settings.
5. Freeze configuration changes during the final backup window.

Completion evidence:

- signed-off service list
- signed-off data retention list
- exported network configuration
- approved maintenance window

### Phase B: preserve and test

1. Copy all retained dumps to `/mnt/backup/pg`.
2. Generate and verify checksums.
3. Perform actual isolated restores.
4. Back up SSH access, encrypted RemoteAgent secrets, and required configuration.
5. Copy the migration evidence to a second machine or storage target.

Completion evidence:

- successful checksum log
- successful restore evidence for every retained database
- two independent copies of critical credentials and restore evidence

### Phase C: clean Ubuntu installation

1. Shut down the host.
2. Physically disconnect the 3.7TB external disk and the 1.8TB NTFS disk.
3. Install a mature Ubuntu LTS release on `/dev/sdc` only.
4. Set hostname `appback-prod`.
5. Configure static address `192.168.33.26/24` and gateway
   `192.168.33.1`.
6. Apply security updates and configure time synchronization.
7. Restore SSH access and verify a second administrative session before
   closing the installation console.

The installer record must include the selected target disk and partition map.

### Phase D: production runtime

Recommended filesystem ownership:

```text
/opt/appback/compose     deployment definitions
/srv/appback/data       persistent application data
/srv/appback/logs       application logs
/mnt/backup             external backup disk
```

Install only the required runtime components:

- Docker Engine and Compose plugin
- reverse proxy such as Nginx or Caddy
- production application stack
- monitoring and log rotation
- RemoteAgent from the published npm package, if it remains required on 26

Expose only HTTP/HTTPS publicly. Keep SSH and database ports restricted to the
internal network or VPN. Verify whether `125.132.17.159` is routed by NAT before
changing host firewall rules.

### Phase E: restore and cutover

1. Reconnect the external disk after Ubuntu is fully installed.
2. Mount it by UUID at `/mnt/backup`; do not reformat it.
3. Restore application databases from the verified backup set.
4. Deploy applications from versioned images/configuration.
5. Run service, database, TLS, upload, and external access checks.
6. Enable scheduled backups only after a manual backup and restore test passes.
7. Change DNS/NAT only during the approved cutover window.

## 7. Acceptance Criteria

The migration is complete only when all of the following are recorded:

- Ubuntu boots with the intended hostname and static internal address
- SSH works from an authorized internal host
- only approved public ports are exposed
- each production container has a versioned image and restart policy
- each required database was restored from a verified dump
- application health and representative user flows pass
- backup writes to the external disk
- a post-install restore test succeeds
- disk, CPU, memory, container, and certificate monitoring is active
- RemoteAgent, if installed, runs as exactly one supervised service
- no SQream or legacy market cron process remains unless separately approved

## 8. Stop Conditions

Stop and report before any destructive step if any of these is true:

- `/mnt/backup/pg` has not been populated and checksum-verified
- a required database has no successful restore test
- the external and NTFS disks cannot be positively distinguished from the OS disk
- public-IP NAT ownership is unclear
- required credentials or SSH recovery access have only one copy
- the application inventory or retention decision is incomplete
- an unexpected active workload is found on server 26

## 9. Rollback

Before OS installation, rollback means leaving RHEL unchanged and keeping the
paused cron jobs paused.

After OS installation, rollback cannot restore the old RHEL installation unless
a full disk image was created. The operational rollback is therefore:

1. keep the prior production server serving traffic
2. restore the verified database backup to the prior or replacement host
3. revert DNS/NAT to the prior production endpoint
4. collect Ubuntu deployment logs before attempting another cutover

Do not designate server 26 as the sole production host until this rollback path
has been tested.

## 10. First Commands for the Next Agent

Use these read-only checks before changing anything:

```bash
ssh ospadmin@192.168.33.26
hostnamectl
ip -br addr
lsblk -o NAME,SIZE,FSTYPE,LABEL,UUID,MOUNTPOINT
df -hT / /home /mnt/backup
systemctl --user status remoteagent --no-pager
pgrep -af 'sqream|remoteagent|run_kr_strategy|run_toss_kr'
crontab -l
find /data/cluster -type f -name '*.dump' -printf '%TY-%Tm-%Td %TH:%TM %s %p\n' | sort | tail
find /mnt/backup/pg -type f -name '*.dump' -printf '%TY-%Tm-%Td %TH:%TM %s %p\n' | sort | tail
```

The next agent should first report the current state and the exact phase it is
starting. No formatting, deletion, package removal, or cron reactivation should
occur merely from reading this document.
