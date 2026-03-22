import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

/** Resolved path to the monorepo docs/ directory. */
const docsDir = path.resolve(import.meta.dir, "../../../../docs");

/**
 * Read a documentation file's content from disk on demand.
 * Returns undefined if the file does not exist.
 */
export async function readDocContent(filename: string): Promise<string | undefined> {
	const filePath = path.join(docsDir, filename);
	try {
		return await Bun.file(filePath).text();
	} catch (err: unknown) {
		if (isEnoent(err)) return undefined;
		logger.warn("Failed to read doc file", { filename, error: err instanceof Error ? err.message : String(err) });
		return undefined;
	}
}
