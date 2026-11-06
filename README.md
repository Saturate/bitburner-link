# bitburner-link

Keep a folder of scripts in sync with [Bitburner](https://github.com/bitburner-official/bitburner-src) through the game's Remote API, and see what every save does to your RAM costs.

```
11:27:20 ✓ game connected on port 12525
11:27:20 ✓ in sync: 191 files (3 pushed, 188 already up to date)
11:27:41 ✓ lib/util.js updated
11:27:41   ram lib/util.js 1.70 GB → 1.90 GB (+0.20)
11:27:41   ram main.js 1.70 GB → 1.90 GB (+0.20) (via an import)
11:28:02 ✗ hack.js: SyntaxError: Unexpected token
```

## Why another sync tool

It started as a replacement for `bitburner-filesync` after a few things kept going wrong:

- **Reconnecting loses edits.** Files saved while the game was closed or disconnected never reached it. bitburner-link compares the content of every file each time the game connects, pushes whatever differs and lists files that exist only in the game.
- **RAM surprises.** Every push asks the game for the new RAM cost of the script and of every script that imports it, and prints the change. Costs are kept in `bitburner-ram.json`, so a RAM increase also shows up in `git diff`.
- **Crashes on locked files.** Editors and formatters on Windows briefly lock files while saving. Those reads are retried instead of taking the tool down.
- **Files made in the game.** `pull` copies them into your folder.
- **Line ending noise.** `NetscriptDefinitions.d.ts` is written with the line endings the file already has, so it only shows as changed when the API really changed.

Saves that don't change anything (format on save, `touch`) aren't pushed again. Scripts the game can't parse are reported when you save them, not when you run them.

## Use it

```sh
npx bitburner-link
```

In the game: **Options > Remote API**, enter the port (12525 by default) and press **Connect**. The game reconnects to the same port when you reload it.

To keep it in a project:

```sh
npm install --save-dev bitburner-link
```

```json
"scripts": { "sync": "bitburner-link" }
```

### Commands

| Command | What it does |
| --- | --- |
| `bitburner-link` | Watch the folder and sync (default) |
| `bitburner-link pull [files...]` | Copy files from the game. Without names: every file that exists only in the game |
| `bitburner-link ram [filter]` | Print the RAM cost of every script, biggest first |
| `bitburner-link init` | Write `bitburner-link.json` with the current settings |

While it's running you can type `pull [files]`, `push` (re-check everything), `ram [filter]` or `quit`.

### Options

| Flag | Default | |
| --- | --- | --- |
| `--port <n>` | `12525` | Port the game connects to |
| `--dir <path>` | `./src` | Local folder that mirrors the server |
| `--server <name>` | `home` | Server to sync with |
| `--delete` | off | Delete game files that don't exist locally, on connect and when you delete them here |
| `--dry` | off | Print what would be pushed or deleted, change nothing |
| `--no-definitions` | | Don't write `NetscriptDefinitions.d.ts` |
| `--no-ram-file` | | Report RAM changes without keeping `bitburner-ram.json` |
| `--no-input` | | No command prompt, for running in the background |

### Config file

Settings are read in this order, later ones winning:

1. `filesync.json`, if you are coming from bitburner-filesync (`port`, `scriptsFolder`, `allowedFiletypes`, `exclude`, `definitionFile`, `allowDeletingFiles`, `dry`)
2. `bitburner-link.json`
3. command line flags

```json
{
	"port": 12525,
	"dir": "./src",
	"server": "home",
	"extensions": [".js", ".jsx", ".ts", ".tsx", ".txt", ".json", ".script"],
	"exclude": ["**/*.d.ts"],
	"definitionFile": "./NetscriptDefinitions.d.ts",
	"ramFile": "./bitburner-ram.json",
	"deleteRemote": false
}
```

`exclude` takes simple globs relative to `dir` (`*`, `**`, `?`). Set `definitionFile` or `ramFile` to `null` to turn them off.

## How RAM tracking works

On the first connect every script is measured once with the game's `calculateRam` and the results are saved. After that, a push re-measures the pushed file plus every script that imports it, directly or through other files, and prints the ones that changed. Imports are found by reading `import` and `export ... from` statements, relative (`./lib/x`) or from the root (`/lib/x.js`).

The game charges RAM for what a script could call, so the numbers match what `mem` shows in the terminal.

## Requirements

Node.js 20 or newer, and a Bitburner version with the Remote API. Tested with Bitburner 3.x.

## Development

```sh
npm install
npm test
```

The tests run the real sync code against a fake game that speaks the same JSON-RPC protocol (`test/fake-game.ts`).

## License

MIT
