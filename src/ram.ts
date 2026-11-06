import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { posix } from "node:path";

// A script's RAM cost depends on everything it imports, so editing a library changes the
// cost of every script that (indirectly) imports it. We keep a small import graph to know
// which scripts to re-measure after a push.

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;

export function parseImports(content: string): string[] {
	const out: string[] = [];
	for (const m of content.matchAll(IMPORT_RE)) out.push(m[1] ?? m[2] ?? m[3]);
	return out;
}

/** Resolve an import the way the game does: relative to the file, or from the root. */
export function resolveImport(from: string, spec: string, known: Set<string>, extensions: string[]): string | null {
	if (spec.startsWith("@") || /^[a-z]+:/i.test(spec)) return null; // "@ns", "node:fs", urls
	const base = spec.startsWith(".") ? posix.join(posix.dirname(from), spec) : spec.replace(/^\/+/, "");
	if (known.has(base)) return base;
	for (const ext of extensions) if (known.has(base + ext)) return base + ext;
	return null;
}

export class ImportGraph {
	// file -> files it imports
	private deps = new Map<string, Set<string>>();

	constructor(private extensions: string[]) {}

	set(file: string, content: string, known: Set<string>) {
		const deps = new Set<string>();
		for (const spec of parseImports(content)) {
			const r = resolveImport(file, spec, known, this.extensions);
			if (r && r !== file) deps.add(r);
		}
		this.deps.set(file, deps);
	}

	delete(file: string) {
		this.deps.delete(file);
	}

	/** The given files plus every file that imports any of them, directly or not. */
	affected(changed: Iterable<string>): Set<string> {
		const out = new Set(changed);
		let grew = true;
		while (grew) {
			grew = false;
			for (const [file, deps] of this.deps) {
				if (out.has(file)) continue;
				for (const d of deps) {
					if (out.has(d)) {
						out.add(file);
						grew = true;
						break;
					}
				}
			}
		}
		return out;
	}
}

export class RamBook {
	private ram: Record<string, number> = {};

	constructor(private path: string | null) {
		if (path && existsSync(path)) {
			try {
				this.ram = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				this.ram = {};
			}
		}
	}

	get size() {
		return Object.keys(this.ram).length;
	}

	get(file: string): number | undefined {
		return this.ram[file];
	}

	set(file: string, gb: number) {
		this.ram[file] = Math.round(gb * 100) / 100;
	}

	delete(file: string) {
		delete this.ram[file];
	}

	save() {
		if (!this.path) return;
		const sorted = Object.fromEntries(Object.entries(this.ram).sort(([a], [b]) => a.localeCompare(b)));
		writeFileSync(this.path, JSON.stringify(sorted, null, "\t") + "\n");
	}
}
