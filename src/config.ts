import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
	port: number;
	// Local folder that mirrors the game's home server.
	dir: string;
	server: string;
	extensions: string[];
	// Glob patterns (relative to dir) that are never synced.
	exclude: string[];
	// Where to write NetscriptDefinitions.d.ts on connect (null = don't).
	definitionFile: string | null;
	// JSON file that remembers each script's RAM cost (null = report only, no file).
	ramFile: string | null;
	// Delete files from the game when they are deleted locally, and game-only files on connect.
	deleteRemote: boolean;
	// Show what would be pushed/deleted without changing anything in the game.
	dryRun: boolean;
	// Run in the background without the stdin command prompt.
	noInput: boolean;
}

const DEFAULTS: Config = {
	port: 12525,
	dir: "./src",
	server: "home",
	extensions: [".js", ".jsx", ".ts", ".tsx", ".txt", ".json", ".script"],
	exclude: ["**/*.d.ts"],
	definitionFile: "NetscriptDefinitions.d.ts",
	ramFile: "bitburner-ram.json",
	deleteRemote: false,
	dryRun: false,
	noInput: false,
};

export const CONFIG_FILE = "bitburner-link.json";

/**
 * Defaults, then bitburner-filesync's filesync.json if present (so switching is free),
 * then bitburner-link.json, then command line flags.
 */
export function loadConfig(cwd: string, flags: Partial<Config>): Config {
	const cfg: Config = { ...DEFAULTS, extensions: [...DEFAULTS.extensions], exclude: [...DEFAULTS.exclude] };

	const filesync = readJson(resolve(cwd, "filesync.json"));
	if (filesync) {
		if (typeof filesync.port === "number") cfg.port = filesync.port;
		if (typeof filesync.scriptsFolder === "string") cfg.dir = filesync.scriptsFolder;
		if (Array.isArray(filesync.allowedFiletypes)) cfg.extensions = filesync.allowedFiletypes;
		if (Array.isArray(filesync.exclude)) cfg.exclude.push(...filesync.exclude);
		const def = filesync.definitionFile as { update?: boolean; location?: string } | undefined;
		if (def) cfg.definitionFile = def.update === false ? null : (def.location ?? cfg.definitionFile);
		if (filesync.allowDeletingFiles === true) cfg.deleteRemote = true;
		if (filesync.dry === true) cfg.dryRun = true;
	}

	const own = readJson(resolve(cwd, CONFIG_FILE));
	if (own) Object.assign(cfg, own);
	Object.assign(cfg, Object.fromEntries(Object.entries(flags).filter(([, v]) => v !== undefined)));

	cfg.dir = resolve(cwd, cfg.dir);
	if (cfg.definitionFile) cfg.definitionFile = resolve(cwd, cfg.definitionFile);
	if (cfg.ramFile) cfg.ramFile = resolve(cwd, cfg.ramFile);
	cfg.extensions = cfg.extensions.map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase());
	return cfg;
}

function readJson(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
	}
}
