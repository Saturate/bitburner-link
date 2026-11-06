import { posix } from "node:path";
import { WebSocket } from "ws";

// Stands in for the game: connects to the link like Options > Remote API > Connect does
// and answers the same JSON-RPC calls from an in-memory home server.

export class FakeGame {
	files = new Map<string, string>();
	calls: { method: string; params: Record<string, unknown> }[] = [];
	definitions = "declare interface NS {}\n";
	// The game caches each script's RAM and drops it only when that script is written,
	// so an importer keeps its old cost after a library changes.
	private ramCache = new Map<string, number>();
	private ws: WebSocket | null = null;

	constructor(initial: Record<string, string> = {}) {
		for (const [k, v] of Object.entries(initial)) this.files.set(k, v);
	}

	connect(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`ws://localhost:${port}`);
			ws.on("open", () => resolve());
			ws.on("error", reject);
			ws.on("message", (data) => this.answer(ws, JSON.parse(data.toString())));
			this.ws = ws;
		});
	}

	disconnect() {
		this.ws?.close();
	}

	private answer(ws: WebSocket, msg: { id: number; method: string; params?: Record<string, unknown> }) {
		const p = msg.params ?? {};
		this.calls.push({ method: msg.method, params: p });
		const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
		const fail = (error: string) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error }));
		const name = String(p.filename ?? "");
		// Like the game: nested paths must come with a leading slash.
		if (name.includes("/") && !name.startsWith("/")) return fail(`bad path ${name}`);
		const key = name.replace(/^\//, "");
		switch (msg.method) {
			case "getAllFiles":
				// The game reports nested files with a leading slash too.
				return reply([...this.files].map(([filename, content]) => ({ filename: filename.includes("/") ? `/${filename}` : filename, content })));
			case "pushFile": {
				// Like the game: only a real content change drops that file's cached RAM, and
				// never its importers'.
				const changed = this.files.get(key) !== String(p.content);
				this.files.set(key, String(p.content));
				if (changed) this.ramCache.delete(key);
				return reply("OK");
			}
			case "getFile":
				return this.files.has(key) ? reply(this.files.get(key)) : fail("file not found");
			case "deleteFile":
				return this.files.delete(key) ? reply("OK") : fail("file not found");
			case "getDefinitionFile":
				return reply(this.definitions);
			case "calculateRam": {
				if (!this.files.has(key)) return fail("file not found");
				if (this.files.get(key)!.includes("SYNTAX ERROR")) return fail("SyntaxError: Unexpected token");
				if (!this.ramCache.has(key)) this.ramCache.set(key, this.ram(key, new Set()));
				return reply(this.ramCache.get(key));
			}
			default:
				return fail(`unknown method ${msg.method}`);
		}
	}

	// 1.6 GB base, plus 0.1 GB per "ns." call in the file and everything it imports.
	private ram(file: string, seen: Set<string>): number {
		const own = (f: string): number => {
			if (seen.has(f)) return 0;
			seen.add(f);
			const text = this.files.get(f) ?? "";
			let total = (text.match(/ns\./g) ?? []).length * 0.1;
			for (const m of text.matchAll(/from\s*["'](\.[^"']+)["']/g)) {
				const dep = posix.join(posix.dirname(f), m[1]);
				total += own(this.files.has(dep) ? dep : dep + ".js");
			}
			return total;
		};
		return 1.6 + own(file);
	}
}
