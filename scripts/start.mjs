import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, "..");
const childEnvironment = { ...process.env };

// Ambientes baseados em Electron podem herdar essa variável. Se ela chegar ao
// executável filho, o Electron se comporta como Node e o app não inicia.
delete childEnvironment.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ["."], {
  cwd: PROJECT_DIR,
  env: childEnvironment,
  stdio: "inherit",
  windowsHide: false
});

child.once("error", () => {
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
