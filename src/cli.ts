#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { CONFIG_FILE, loadConfig, type Config } from "./config.js";
import { Game } from "./game.js";
import { Link } from "./link.js";
import { c, log } from "./log.js";

const HELP = `
bitburner-link: sync a folder with Bitburner's home server over the Remote API

Usage
  bitburner-link [options]          watch and sync (default)
  bitburner-link pull [files...]    copy files from the game (default: the ones missing here)
  bitburner-link ram [filter]       print the RAM cost of every script
  bitburner-link init               write ${CONFIG_FILE} with the defaults

Options
  --port <n>          port the game connects to (default 12525)
  --dir <path>        local folder that mirrors home (default ./src)
  --server <name>     server to sync with (default home)
  --delete            also delete game files that don't exist locally
  --dry               show what would change, change nothing
  --no-definitions    don't write NetscriptDefinitions.d.ts
  --no-ram-file       don't keep bitburner-ram.json
  --no-input          no command prompt (for running in the background)
  -h, --help          this text
  -v, --version       version

While running, type: pull [files], push, ram [filter], help, quit

In the game: Options > Remote API, set the port, leave "Use wss" unchecked, press Connect.
Settings are read from filesync.json (if you used bitburner-filesync), then ${CONFIG_FILE}, then flags.
`;

function parseArgs(argv: string[]): { command: string; rest: string[]; flags: Partial<Config> } {
	const flags: Partial<Config> = {};
	const rest: string[] = [];
	let command = "serve";
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${a} needs a value`);
			return v;
		};
		if (a === "-h" || a === "--help") command = "help";
		else if (a === "-v" || a === "--version") command = "version";
		else if (a === "--port") flags.port = Number(next());
		else if (a === "--dir") flags.dir = next();
		else if (a === "--server") flags.server = next();
		else if (a === "--delete") flags.deleteRemote = true;
		else if (a === "--dry") flags.dryRun = true;
		else if (a === "--no-definitions") flags.definitionFile = null;
		else if (a === "--no-ram-file") flags.ramFile = null;
		else if (a === "--no-input") flags.noInput = true;
		else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
		else if (command === "serve" && rest.length === 0 && ["pull", "ram", "init", "serve"].includes(a)) command = a;
		else rest.push(a);
	}
	if (flags.port !== undefined && !(flags.port > 0 && flags.port < 65536)) throw new Error("--port must be 1-65535");
	return { command, rest, flags };
}

function version(): string {
	const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	return pkg.version;
}

async function main() {
	const { command, rest, flags } = parseArgs(process.argv.slice(2));
	if (command === "help") return console.log(HELP);
	if (command === "version") return console.log(version());
	if (command === "init") {
		if (existsSync(CONFIG_FILE)) return log.warn(`${CONFIG_FILE} already exists`);
		const cfg = loadConfig(process.cwd(), flags);
		const rel = (p: string | null) => (p ? "./" + p.slice(process.cwd().length + 1).replace(/\\/g, "/") : null);
		const out = {
			port: cfg.port,
			dir: rel(cfg.dir),
			server: cfg.server,
			extensions: cfg.extensions,
			exclude: cfg.exclude,
			definitionFile: rel(cfg.definitionFile),
			ramFile: rel(cfg.ramFile),
			deleteRemote: cfg.deleteRemote,
		};
		writeFileSync(CONFIG_FILE, JSON.stringify(out, null, "\t") + "\n");
		return log.ok(`wrote ${CONFIG_FILE}`);
	}

	const cfg = loadConfig(process.cwd(), flags);
	if (!existsSync(cfg.dir)) throw new Error(`${cfg.dir} doesn't exist (set --dir or "dir" in ${CONFIG_FILE})`);

	const game = new Game(cfg.port);
	const link = new Link(cfg, game);
	game.on("error", (e: NodeJS.ErrnoException) => {
		log.error(e.code === "EADDRINUSE" ? `port ${cfg.port} is in use (is another sync tool running?)` : e.message);
		process.exit(1);
	});
	await new Promise<void>((r) => game.once("listening", r));
	log.info(`${c.bold("bitburner-link")} ${version()} on port ${cfg.port}, syncing ${c.dim(cfg.dir)}${cfg.dryRun ? c.yellow(" (dry run)") : ""}`);
	log.info(c.dim(`waiting for the game: Options > Remote API, port ${cfg.port}, "Use wss" off, Connect`));

	// One-shot commands: wait for the game, do it, exit.
	if (command === "pull" || command === "ram") {
		await new Promise<void>((r) => game.once("connect", r));
		await link.idle(); // the connect diff runs first
		if (command === "pull") await link.serial(() => link.pull(rest));
		else link.ramTable(rest[0] ?? "");
		await game.close();
		return;
	}

	link.watch();
	const quit = async () => {
		link.stop();
		await game.close();
		process.exit(0);
	};
	process.on("SIGINT", quit);

	if (!cfg.noInput && process.stdin.isTTY) {
		const rl = createInterface({ input: process.stdin });
		rl.on("line", (line) => {
			const [cmd, ...args] = line.trim().split(/\s+/);
			if (!cmd) return;
			if (cmd === "pull") link.serial(() => link.pull(args));
			else if (cmd === "push") link.serial(() => link.pushAll());
			else if (cmd === "ram") link.ramTable(args[0] ?? "");
			else if (cmd === "quit" || cmd === "exit") quit();
			else if (cmd === "help") console.log("  pull [files]   copy files from the game\n  push           re-check every file and push differences\n  ram [filter]   RAM per script\n  quit");
			else log.warn(`unknown command ${cmd} (try help)`);
		});
	}
}

main().catch((e) => {
	log.error(e instanceof Error ? e.message : String(e));
	process.exit(1);
});
