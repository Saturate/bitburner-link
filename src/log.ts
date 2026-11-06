// Small colored logger. Colors switch off when output isn't a terminal or NO_COLOR is set.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
	dim: paint(2),
	red: paint(31),
	green: paint(32),
	yellow: paint(33),
	blue: paint(34),
	cyan: paint(36),
	bold: paint(1),
};

const time = () => c.dim(new Date().toTimeString().slice(0, 8));

export const log = {
	info: (msg: string) => console.log(`${time()} ${msg}`),
	ok: (msg: string) => console.log(`${time()} ${c.green("✓")} ${msg}`),
	warn: (msg: string) => console.log(`${time()} ${c.yellow("!")} ${msg}`),
	error: (msg: string) => console.log(`${time()} ${c.red("✗")} ${msg}`),
};

export function gb(n: number): string {
	return `${n.toFixed(2)} GB`;
}

export function delta(before: number | undefined, after: number): string {
	if (before === undefined) return c.dim(gb(after));
	const d = after - before;
	if (Math.abs(d) < 0.005) return c.dim(gb(after));
	const s = `${gb(before)} → ${gb(after)} (${d > 0 ? "+" : ""}${d.toFixed(2)})`;
	return d > 0 ? c.yellow(s) : c.green(s);
}
