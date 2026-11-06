import { watch, type FSWatcher } from "node:fs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { isScript, listLocal, makeFilter, readSettled } from "./files.js";
import { Game, localPath } from "./game.js";
import { c, delta, gb, log } from "./log.js";
import { ImportGraph, RamBook } from "./ram.js";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Keeps a local folder and the game's home server in sync:
 * - on (re)connect, diff contents both ways and push whatever differs
 * - on save, push the file and re-measure RAM for it and everything that imports it
 */
export class Link {
	readonly include: (file: string) => boolean;
	// What the game has, as far as we know (filename -> content).
	private remote = new Map<string, string>();
	private local = new Set<string>();
	private graph: ImportGraph;
	private ram: RamBook;
	private watcher: FSWatcher | null = null;
	private queued = new Set<string>();
	private timer: NodeJS.Timeout | null = null;
	// Everything that talks to the game runs one at a time, in order.
	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		readonly cfg: Config,
		readonly game: Game,
	) {
		this.include = makeFilter(cfg);
		this.graph = new ImportGraph(cfg.extensions);
		this.ram = new RamBook(cfg.ramFile);
		game.on("connect", () => this.serial(() => this.onConnect()));
		game.on("disconnect", () => log.warn("game disconnected, waiting for it to reconnect"));
	}

	watch() {
		this.watcher = watch(this.cfg.dir, { recursive: true }, (_event, name) => {
			if (!name) return;
			const file = localPath(name.toString());
			if (!this.include(file)) return;
			this.queued.add(file);
			// Editors fire several events per save; wait for them to settle.
			if (this.timer) clearTimeout(this.timer);
			this.timer = setTimeout(() => this.serial(() => this.flush()), 150);
		});
	}

	stop() {
		this.watcher?.close();
		if (this.timer) clearTimeout(this.timer);
	}

	/** Resolves once every queued operation has finished (tests use this). */
	idle(): Promise<unknown> {
		return this.chain;
	}

	serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn, fn);
		this.chain = run.catch((e) => log.error(e instanceof Error ? e.message : String(e)));
		return run;
	}

	// ── connect: full diff ──

	private async onConnect() {
		log.ok(`game connected on port ${this.game.port}`);
		await this.updateDefinitions();

		const remote = await this.game.getAllFiles(this.cfg.server);
		this.remote = new Map(remote.filter((f) => this.include(f.filename)).map((f) => [f.filename, f.content]));

		const files = await listLocal(this.cfg, this.include);
		this.local = new Set(files);
		const contents = new Map<string, string>();
		for (const f of files) {
			const text = await readSettled(join(this.cfg.dir, f));
			if (text !== null) contents.set(f, text);
		}
		for (const [f, text] of contents) this.graph.set(f, text, this.local);

		const changed = [...contents].filter(([f, text]) => this.remote.get(f) !== text);
		const onlyRemote = [...this.remote.keys()].filter((f) => !this.local.has(f)).sort();

		for (const [f, text] of changed) await this.push(f, text, this.remote.has(f) ? "updated" : "new");
		if (onlyRemote.length) {
			if (this.cfg.deleteRemote) for (const f of onlyRemote) await this.remove(f);
			else {
				const shown = onlyRemote.slice(0, 8).join(", ") + (onlyRemote.length > 8 ? `, +${onlyRemote.length - 8} more` : "");
				log.warn(`${onlyRemote.length} file${onlyRemote.length === 1 ? "" : "s"} only in the game: ${shown}`);
				log.info(c.dim(`  type "pull" to copy them here, or run with --delete to remove them from the game`));
			}
		}

		const same = contents.size - changed.length;
		log.ok(`in sync: ${plural(contents.size, "file")} (${changed.length} pushed, ${same} already up to date)`);

		// First run: measure everything once so later changes have something to compare to.
		if (this.ram.size === 0) await this.measure(files.filter(isScript), { quiet: true });
		else await this.measure(changed.map(([f]) => f));
	}

	private async updateDefinitions() {
		const path = this.cfg.definitionFile;
		if (!path) return;
		try {
			let text = await this.game.getDefinitionFile();
			// Keep whatever line endings the file already uses, so git sees no change.
			const old = existsSync(path) ? readFileSync(path, "utf8") : null;
			const crlf = old?.includes("\r\n") ?? false;
			text = text.replace(/\r\n/g, "\n");
			if (crlf) text = text.replace(/\n/g, "\r\n");
			if (text !== old) {
				writeFileSync(path, text);
				log.ok(`updated ${c.dim(path)}`);
			}
		} catch (e) {
			log.warn(`couldn't fetch the definition file: ${(e as Error).message}`);
		}
	}

	// ── saves ──

	private async flush() {
		const files = [...this.queued].sort();
		this.queued.clear();
		const pushed: string[] = [];
		for (const f of files) {
			const text = await readSettled(join(this.cfg.dir, f));
			if (text === null) {
				this.local.delete(f);
				this.graph.delete(f);
				this.ram.delete(f);
				if (this.cfg.deleteRemote && this.remote.has(f)) await this.remove(f);
				continue;
			}
			this.local.add(f);
			this.graph.set(f, text, this.local);
			// Saves that didn't change anything (touch, format on save) are skipped.
			if (this.remote.get(f) === text) continue;
			if (await this.push(f, text, this.remote.has(f) ? "updated" : "new")) pushed.push(f);
		}
		if (pushed.length) await this.measure(pushed);
		this.ram.save();
	}

	private async push(file: string, content: string, what: string): Promise<boolean> {
		if (!this.game.connected) return false;
		if (this.cfg.dryRun) {
			log.info(`${c.cyan("would push")} ${file} ${c.dim(`(${what})`)}`);
			return false;
		}
		try {
			await this.game.pushFile(file, content, this.cfg.server);
			this.remote.set(file, content);
			log.ok(`${file} ${c.dim(what)}`);
			return true;
		} catch (e) {
			log.error(`${file}: ${(e as Error).message}`);
			return false;
		}
	}

	private async remove(file: string) {
		if (this.cfg.dryRun) return log.info(`${c.cyan("would delete")} ${file} from the game`);
		try {
			await this.game.deleteFile(file, this.cfg.server);
			this.remote.delete(file);
			log.ok(`${file} ${c.dim("deleted from the game")}`);
		} catch (e) {
			log.error(`deleting ${file}: ${(e as Error).message}`);
		}
	}

	// ── RAM ──

	/**
	 * Ask the game what the changed scripts and everything importing them now cost, and
	 * report the differences. calculateRam errors are usually syntax or import errors,
	 * which is worth knowing before you run the script.
	 */
	async measure(changed: string[], opts: { quiet?: boolean } = {}) {
		if (!this.game.connected || changed.length === 0) return;
		const direct = new Set(changed);
		const targets = [...this.graph.affected(changed)].filter((f) => isScript(f) && this.remote.has(f)).sort();
		let measured = 0;
		for (const f of targets) {
			try {
				// The game caches each script's RAM and only drops it when that script's content
				// changes, so a script affected through an import would report its old cost.
				// Writing it with an extra newline and then back as it was makes it recompute
				// (an identical write is ignored).
				const content = this.remote.get(f);
				if (!direct.has(f) && content !== undefined && !opts.quiet) {
					await this.game.pushFile(f, content + "\n", this.cfg.server);
					await this.game.pushFile(f, content, this.cfg.server);
				}
				const ram = await this.game.calculateRam(f, this.cfg.server);
				const before = this.ram.get(f);
				this.ram.set(f, ram);
				measured++;
				const moved = before === undefined || Math.abs(before - ram) >= 0.005;
				if (!opts.quiet && (moved || direct.has(f))) {
					log.info(`  ${c.dim("ram")} ${f} ${delta(before, ram)}${direct.has(f) ? "" : c.dim(" (via an import)")}`);
				}
			} catch (e) {
				log.error(`${f}: ${(e as Error).message}`);
			}
		}
		if (opts.quiet && measured) log.ok(`measured RAM for ${plural(measured, "script")}${this.cfg.ramFile ? c.dim(` (${this.cfg.ramFile})`) : ""}`);
		this.ram.save();
	}

	// ── commands ──

	async pull(files: string[]) {
		if (!this.game.connected) return log.warn("game not connected");
		const all = await this.game.getAllFiles(this.cfg.server);
		const byName = new Map(all.map((f) => [f.filename, f.content]));
		const wanted = files.length ? files.map(localPath) : all.map((f) => f.filename).filter((f) => this.include(f) && !this.local.has(f));
		if (wanted.length === 0) return log.info("nothing to pull: every game file is already here");
		for (const f of wanted) {
			const content = byName.get(f);
			if (content === undefined) {
				log.error(`${f} isn't on ${this.cfg.server}`);
				continue;
			}
			const abs = join(this.cfg.dir, f);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, content);
			this.remote.set(f, content);
			this.local.add(f);
			this.graph.set(f, content, this.local);
			log.ok(`pulled ${f}`);
		}
	}

	async pushAll() {
		this.remote.clear();
		await this.onConnect();
	}

	ramTable(filter = "") {
		const rows = [...this.local]
			.filter((f) => isScript(f) && f.includes(filter) && this.ram.get(f) !== undefined)
			.map((f) => [f, this.ram.get(f)!] as const)
			.sort((a, b) => b[1] - a[1]);
		if (!rows.length) return log.info("no RAM measured yet");
		const width = Math.max(...rows.map(([f]) => f.length));
		for (const [f, r] of rows) console.log(`  ${f.padEnd(width)}  ${gb(r).padStart(9)}`);
	}
}
