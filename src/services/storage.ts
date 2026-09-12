/**
 * Does the bot's database survive a deploy, and how we can tell.
 *
 * Kept apart from db.ts because importing that module opens the file and
 * creates the schema, and this rule is worth a test that does neither.
 */

/**
 * Whether the file the subscriptions live in is on real storage.
 *
 * On the host this runs on, the filesystem is thrown away with the container
 * unless a volume is mounted, and nothing says which it is: /track answers
 * "готово" either way, and the subscription is gone at the next deploy. So
 * every boot writes down which build it was, and the rows already there
 * answer the question - a row from a different build is proof that the file
 * outlived that build, which is exactly what a volume means.
 */
export interface StorageReport {
  /** Boots recorded before this one. */
  previousBoots: number;
  /** The first of them, so the reader can see how far back the file goes. */
  firstBootAt?: string;
  verdict: "survived-deploy" | "survived-restart" | "unknown" | "new-file";
  /**
   * Whether the build is identifiable at all. Without it "survived a
   * restart" is all this check can ever say, however many deploys pass.
   */
  buildKnown: boolean;
  /** Whether the database sits inside a mounted volume. */
  onVolume: boolean;
}

/**
 * Whether the database file lives inside the host's mounted volume.
 *
 * A volume mounted for the first time is empty, exactly like no volume at
 * all, so the boots table cannot tell the two apart on the first run - and
 * it reported a correctly mounted volume as "похоже на контейнер без тома",
 * which is the opposite of what had just been set up. The host says so
 * directly, so it is asked rather than inferred.
 *
 * Compared as path segments: a mount at /data must not match /database,
 * which a plain prefix test would accept.
 */
export function isOnVolume(dbPath: string, mountPath: string): boolean {
  if (!mountPath) return false;
  // Both have to be absolute. Dropping the leading empty segment makes
  // "data/bot.db" and "/data/bot.db" identical, so a relative path - which
  // resolves against the working directory, inside the container, and is
  // the default this whole check exists to catch - would match a mount at
  // "/data" and be reported as sitting on the volume.
  if (!mountPath.startsWith("/") || !dbPath.startsWith("/")) return false;
  const segments = (p: string) => p.replace(/\/+$/, "").split("/").filter(Boolean);
  const mount = segments(mountPath);
  const file = segments(dbPath);
  if (mount.length === 0 || file.length <= mount.length) return false;
  return mount.every((part, i) => file[i] === part);
}

/**
 * @param fileExisted whether the database file was already on disk when this
 *   process opened it. It separates the two ways of having no boots recorded:
 *   a container that started with an empty filesystem, which is the answer
 *   the reader is after, and the first run of this check itself on storage
 *   that has been there all along - which proves nothing either way and must
 *   not be reported as a missing volume.
 */
export function verdictFrom(
  previous: { sha: string | null }[],
  currentSha: string,
  fileExisted = false
): StorageReport["verdict"] {
  if (previous.length === 0) return fileExisted ? "unknown" : "new-file";
  // A build other than this one wrote into this file, so the file is older
  // than the build: only a mounted volume does that. Without a commit sha
  // in the environment there is nothing to compare, and every deploy looks
  // like a restart - so that case is "restart", never "deploy", and the
  // report says which build it could not see rather than claiming a volume.
  if (previous.some((b) => (b.sha ?? "") !== currentSha)) return "survived-deploy";
  return "survived-restart";
}
