import { EventEmitter } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";

// The game is the websocket client: Options > Remote API > Connect. We send JSON-RPC 2.0
// requests and it answers each with { id, result } or { id, error }.

export interface RemoteFile {
	filename: string;
	content: string;
}

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
}

export class Game extends EventEmitter {
	private wss: WebSocketServer;
	private ws: WebSocket | null = null;
	private nextId = 0;
	private pending = new Map<number, Pending>();

	constructor(
		readonly port: number,
		private timeoutMs = 15_000,
	) {
		super();
		this.wss = new WebSocketServer({ port });
		this.wss.on("listening", () => this.emit("listening"));
		this.wss.on("error", (e) => this.emit("error", e));
		this.wss.on("connection", (ws) => {
			// One game at a time; a new connection (game reload) replaces the old one.
			if (this.ws) this.ws.close();
			this.ws = ws;
			ws.on("message", (data) => this.onMessage(data.toString()));
			ws.on("close", () => {
				if (this.ws !== ws) return;
				this.ws = null;
				this.failAll(new Error("game disconnected"));
				this.emit("disconnect");
			});
			this.emit("connect");
		});
	}

	get connected(): boolean {
		return this.ws !== null;
	}

	call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
		const ws = this.ws;
		if (!ws) return Promise.reject(new Error("game not connected"));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, this.timeoutMs);
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }));
		});
	}

	// ── the Remote API, typed ──

	pushFile(filename: string, content: string, server = "home") {
		return this.call<string>("pushFile", { filename: gamePath(filename), content, server });
	}
	getFile(filename: string, server = "home") {
		return this.call<string>("getFile", { filename: gamePath(filename), server });
	}
	deleteFile(filename: string, server = "home") {
		return this.call<string>("deleteFile", { filename: gamePath(filename), server });
	}
	async getAllFiles(server = "home"): Promise<RemoteFile[]> {
		const files = await this.call<RemoteFile[]>("getAllFiles", { server });
		return files.map((f) => ({ filename: localPath(f.filename), content: f.content }));
	}
	calculateRam(filename: string, server = "home") {
		return this.call<number>("calculateRam", { filename: gamePath(filename), server });
	}
	getDefinitionFile() {
		return this.call<string>("getDefinitionFile");
	}

	close(): Promise<void> {
		this.ws?.close();
		return new Promise((r) => this.wss.close(() => r()));
	}

	private onMessage(raw: string) {
		let msg: { id?: unknown; result?: unknown; error?: unknown };
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof msg.id !== "number") return;
		const p = this.pending.get(msg.id);
		if (!p) return;
		this.pending.delete(msg.id);
		clearTimeout(p.timer);
		if (msg.error != null) p.reject(new Error(String(msg.error)));
		else p.resolve(msg.result);
	}

	private failAll(e: Error) {
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(e);
		}
		this.pending.clear();
	}
}

// The game wants a leading slash on paths inside folders ("/lib/x.js") and none at the root.
export function gamePath(p: string): string {
	const clean = localPath(p);
	return clean.includes("/") ? `/${clean}` : clean;
}

export function localPath(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\/+/, "");
}
