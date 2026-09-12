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
  verdict: "survived-deploy" | "survived-restart" | "unknown";
  /**
   * Whether the build is identifiable at all. Without it "survived a
   * restart" is all this check can ever say, however many deploys pass.
   */
  buildKnown: boolean;
}

export function verdictFrom(
  previous: { sha: string | null }[],
  currentSha: string
): StorageReport["verdict"] {
  if (previous.length === 0) return "unknown";
  // A build other than this one wrote into this file, so the file is older
  // than the build: only a mounted volume does that. Without a commit sha
  // in the environment there is nothing to compare, and every deploy looks
  // like a restart - so that case is "restart", never "deploy", and the
  // report says which build it could not see rather than claiming a volume.
  if (previous.some((b) => (b.sha ?? "") !== currentSha)) return "survived-deploy";
  return "survived-restart";
}
