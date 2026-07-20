/**
 * Legacy git-checkpoint extension — intentionally retired.
 *
 * The previous implementation created an empty/local working-branch commit before
 * every edit/write, omitted untracked files (`git add -u`), never pushed remotely,
 * and could spawn a visible Git-for-Windows console chain. It was rollback noise,
 * not a verified backup.
 *
 * Safe automated backups now live in `extensions/git-backup/` and use isolated
 * refs, secret/size/path gates, dedicated remote backup branches, and independent
 * remote-tip verification. Keep this no-op file as migration documentation and to
 * prevent accidental reintroduction of the old behavior.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function retiredGitCheckpoint(_pi: ExtensionAPI): void {
  // Intentionally empty.
}
