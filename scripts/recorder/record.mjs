// Drives a program in a PTY and emits an asciicast v2 cassette.
// Usage: pnpm start -- --cmd vim --cols 80 --rows 24 \
//        --out ../../src/modules/terminal/__tui_compat__/cassettes/altscreen-vim.cast \
//        --keys 'ihello from vim\x1b:wq!\r'
// \r in --keys is CR (Enter); \x1b is ESC. Keystrokes are sent with a small
// fixed delay between them so interactive programs repaint deterministically.
import { spawn as ptySpawn } from "node-pty";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function decode(s) {
  return s.replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\x1b/g, "\x1b");
}

const cmd = arg("cmd", "vim");
const cols = Number(arg("cols", "80"));
const rows = Number(arg("rows", "24"));
const out = resolve(arg("out", "cassette.cast"));
const keys = decode(arg("keys", ""));
const cwd = arg("cwd", process.cwd());

const events = [];
const start = Date.now();
const proc = ptySpawn(cmd, [], { cols, rows, cwd, name: "xterm" });

proc.onData((d) => {
  events.push([(Date.now() - start) / 1000, "o", d]);
});

setTimeout(() => {
  for (const ch of keys) {
    proc.write(ch);
  }
}, 200);

setTimeout(() => {
  try {
    proc.kill();
  } catch {}
}, 200 + keys.length * 15 + 1500);

proc.onExit(() => {
  const lines = [
    JSON.stringify({ version: 2, width: cols, height: rows, title: "altscreen-vim" }),
    ...events.map((e) => JSON.stringify(e)),
  ];
  writeFileSync(out, `${lines.join("\n")}\n`);
  // eslint-disable-next-line no-console
  console.log(`wrote ${out} (${events.length} events)`);
});
