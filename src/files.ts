import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { Config } from "./config.js";
import { localPath } from "./game.js";

const SCRIPT_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".script"]);

export const isScript = (file: string) => SCRIPT_EXT.has(extname(file).toLowerCase());

export function makeFilter(cfg: Config): (file: string) => boolean {
	const excludes = cfg.exclude.map(globToRegExp);
	return (file) => cfg.extensions.includes(extname(file).toLowerCase()) && !excludes.some((r) => r.test(file));
}

// Supports **, * and ? (enough for ignore lists); paths are posix and relative to dir.
export function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
			i += glob[i + 2] === "/" ? 2 : 1;
		} else if (c === "*") re += "[^/]*";
		else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

/** Every syncable file under dir, as posix paths relative to dir. */
export async function listLocal(cfg: Config, include: (f: string) => boolean): Promise<string[]> {
	const out: string[] = [];
	const walk = async (abs: string) => {
		for (const e of await readdir(abs, { withFileTypes: true })) {
			const full = join(abs, e.name);
			if (e.isDirectory()) {
				if (e.name !== "node_modules" && !e.name.startsWith(".")) await walk(full);
			} else {
				const rel = localPath(relative(cfg.dir, full));
				if (include(rel)) out.push(rel);
			}
		}
	};
	await walk(cfg.dir);
	return out.sort();
}

/**
 * Read a file an editor may still be writing. Windows editors and formatters often hold
 * the file for a moment (EBUSY/EPERM), and some save by truncating first (empty read).
 */
export async function readSettled(abs: string, tries = 8): Promise<string | null> {
	let recheckedEmpty = false;
	for (let i = 0; i < tries; i++) {
		try {
			const text = await readFile(abs, "utf8");
			// An empty read right after a change is usually mid-save; look once more.
			if (text === "" && !recheckedEmpty) {
				recheckedEmpty = true;
				await sleep(80);
				continue;
			}
			return text;
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return null;
			if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw e;
			await sleep(50 * (i + 1));
		}
	}
	throw new Error(`${abs} stayed locked`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
