import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { globToRegExp } from "../src/files.js";
import { Game, gamePath } from "../src/game.js";
import { Link } from "../src/link.js";
import { parseImports } from "../src/ram.js";
import { FakeGame } from "./fake-game.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await wait(20);
	}
}

let port = 23000 + Math.floor(Math.random() * 2000);

function setup(local: Record<string, string>, extra: Record<string, unknown> = {}) {
	const root = mkdtempSync(join(tmpdir(), "bb-link-"));
	const dir = join(root, "src");
	for (const [f, text] of Object.entries(local)) {
		mkdirSync(join(dir, f, ".."), { recursive: true });
		writeFileSync(join(dir, f), text);
	}
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(root, "bitburner-link.json"), JSON.stringify({ dir: "./src", ...extra }));
	const cfg = loadConfig(root, { port: port++ });
	const game = new Game(cfg.port, 3000);
	const link = new Link(cfg, game);
	return { root, dir, cfg, game, link };
}

describe("connect", () => {
	const fake = new FakeGame({
		"same.js": "export const a = 1;",
		"lib/changed.js": "old",
		"old.js": "game only",
		"notes.txt": "game only too",
	});
	let env: ReturnType<typeof setup>;

	before(async () => {
		env = setup({
			"same.js": "export const a = 1;",
			"lib/changed.js": "export function f(ns) { ns.hack(); ns.grow(); }",
			"new.js": 'import { f } from "./lib/changed";\nexport async function main(ns) { ns.print(); }',
		});
		await new Promise((r) => env.game.once("listening", r));
		await fake.connect(env.cfg.port);
		await wait(50);
		await env.link.idle();
	});
	after(async () => {
		fake.disconnect();
		await env.game.close();
		rmSync(env.root, { recursive: true, force: true });
	});

	test("pushes only what differs", () => {
		const pushed = fake.calls.filter((c) => c.method === "pushFile").map((c) => c.params.filename);
		assert.deepEqual(pushed.sort(), ["/lib/changed.js", "new.js"]);
		assert.equal(fake.files.get("lib/changed.js"), "export function f(ns) { ns.hack(); ns.grow(); }");
	});

	test("leaves game-only files alone without --delete", () => {
		assert.ok(fake.files.has("old.js"));
		assert.ok(!fake.calls.some((c) => c.method === "deleteFile"));
	});

	test("writes the definition file", () => {
		assert.equal(readFileSync(env.cfg.definitionFile!, "utf8"), fake.definitions);
	});

	test("records RAM, including imports", () => {
		const ram = JSON.parse(readFileSync(env.cfg.ramFile!, "utf8"));
		assert.equal(ram["new.js"], 1.9); // 1.6 + own ns.print + ns.hack/ns.grow via the import
		assert.equal(ram["same.js"], 1.6);
		assert.equal(ram["notes.txt"], undefined);
	});

	test("pull copies game-only files here", async () => {
		await env.link.serial(() => env.link.pull([]));
		assert.equal(readFileSync(join(env.dir, "old.js"), "utf8"), "game only");
		assert.equal(readFileSync(join(env.dir, "notes.txt"), "utf8"), "game only too");
	});
});

describe("watch", () => {
	const fake = new FakeGame();
	let env: ReturnType<typeof setup>;

	before(async () => {
		env = setup({
			"lib/util.js": "export function u(ns) { ns.print(); }",
			"main.js": 'import { u } from "./lib/util.js";\nexport async function main(ns) { u(ns); }',
		});
		await new Promise((r) => env.game.once("listening", r));
		env.link.watch();
		await fake.connect(env.cfg.port);
		await until(() => fake.files.size === 2);
		await env.link.idle();
	});
	after(async () => {
		env.link.stop();
		fake.disconnect();
		await env.game.close();
		rmSync(env.root, { recursive: true, force: true });
	});

	test("a save is pushed and importers are re-measured", async () => {
		const ramOf = () => JSON.parse(readFileSync(env.cfg.ramFile!, "utf8"));
		assert.equal(ramOf()["main.js"], 1.7);
		writeFileSync(join(env.dir, "lib/util.js"), "export function u(ns) { ns.print(); ns.hack(); ns.grow(); }");
		await until(() => fake.files.get("lib/util.js")?.includes("grow") ?? false);
		await wait(50);
		await env.link.idle();
		assert.equal(ramOf()["main.js"], 1.9);
	});

	test("a save without changes isn't pushed again", async () => {
		const before = fake.calls.filter((c) => c.method === "pushFile").length;
		writeFileSync(join(env.dir, "main.js"), readFileSync(join(env.dir, "main.js"), "utf8"));
		await wait(400);
		await env.link.idle();
		assert.equal(fake.calls.filter((c) => c.method === "pushFile").length, before);
	});

	test("a script the game can't parse is reported, not fatal", async () => {
		writeFileSync(join(env.dir, "bad.js"), "SYNTAX ERROR");
		await until(() => fake.files.has("bad.js"));
		await wait(50);
		await env.link.idle();
		writeFileSync(join(env.dir, "good.js"), "export async function main(ns) {}");
		await until(() => fake.files.has("good.js"));
	});

	test("reconnecting pushes edits made while disconnected", async () => {
		fake.disconnect();
		await wait(100);
		writeFileSync(join(env.dir, "main.js"), "export async function main(ns) { /* offline edit */ }");
		await wait(400);
		assert.ok(!fake.files.get("main.js")!.includes("offline edit"));
		await fake.connect(env.cfg.port);
		await until(() => fake.files.get("main.js")!.includes("offline edit"));
	});
});

describe("delete mode", () => {
	test("--delete removes game-only files on connect", async () => {
		const fake = new FakeGame({ "keep.js": "x", "stale.js": "y" });
		const env = setup({ "keep.js": "x" }, { deleteRemote: true });
		await new Promise((r) => env.game.once("listening", r));
		await fake.connect(env.cfg.port);
		await until(() => !fake.files.has("stale.js"));
		assert.ok(fake.files.has("keep.js"));
		fake.disconnect();
		await env.game.close();
		rmSync(env.root, { recursive: true, force: true });
	});
});

describe("helpers", () => {
	test("game paths", () => {
		assert.equal(gamePath("a.js"), "a.js");
		assert.equal(gamePath("lib/a.js"), "/lib/a.js");
		assert.equal(gamePath("lib\\a.js"), "/lib/a.js");
		assert.equal(gamePath("/lib/a.js"), "/lib/a.js");
	});

	test("globs", () => {
		assert.ok(globToRegExp("**/*.d.ts").test("NetscriptDefinitions.d.ts"));
		assert.ok(globToRegExp("**/*.d.ts").test("types/x.d.ts"));
		assert.ok(!globToRegExp("**/*.d.ts").test("x.ts"));
		assert.ok(globToRegExp("old/*").test("old/a.js"));
		assert.ok(!globToRegExp("old/*").test("old/deep/a.js"));
	});

	test("imports", () => {
		const src = `import type { NS } from "@ns";\nimport { a } from "./a";\nexport { b } from '../b.js';\nconst c = await import("/lib/c.js");\nimport "./side";`;
		assert.deepEqual(parseImports(src), ["@ns", "./a", "../b.js", "/lib/c.js", "./side"]);
	});

	test("filesync.json settings carry over", () => {
		const root = mkdtempSync(join(tmpdir(), "bb-link-"));
		writeFileSync(join(root, "filesync.json"), JSON.stringify({ port: 4242, scriptsFolder: "./scripts", allowedFiletypes: [".ts"], exclude: ["old/**"] }));
		const cfg = loadConfig(root, {});
		assert.equal(cfg.port, 4242);
		assert.equal(cfg.dir, join(root, "scripts"));
		assert.deepEqual(cfg.extensions, [".ts"]);
		assert.ok(cfg.exclude.includes("old/**"));
		rmSync(root, { recursive: true, force: true });
	});
});
