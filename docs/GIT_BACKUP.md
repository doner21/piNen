# Isolated Git Backup

piNen's `git_backup` extension creates rollback snapshots without committing to or pushing the working branch.

- Local refs: `refs/pi-backups/<host>/<branch>`
- Remote refs: `refs/heads/pi-backup/<host>/<branch>`
- Remote policy: an already-configured `origin` only
- Hard gates: gitleaks, protected paths, embedded repositories, changed-file limits, blob/data size limits
- Verification: `git ls-remote` must match the local snapshot before the result is `remote-verified`

The extension never creates a repository/remote, changes repository visibility, force-pushes, stages into the real index, or mutates the working branch.

Optional config:

```bash
cp agent/git-backup/config.example.json agent/git-backup/config.json
```

The real config, state, logs, locks, and temp files are ignored. `local-snapshot` is rollback protection only; only `remote-verified` confirms off-machine protection.
