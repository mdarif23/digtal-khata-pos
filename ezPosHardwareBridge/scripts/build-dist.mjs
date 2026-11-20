/**
 * Builds the Windows bridge distribution zip (the "installer" a store's IT
 * technician downloads from the backend — no repo, no Node install, no npm).
 *
 *   ezpos-bridge-win64.zip
 *     node.exe                copied from the RUNNING node (so build on the
 *                             same platform/arch you ship: win32 x64)
 *     bridge.mjs              esbuild bundle of src/index.ts (koffi external)
 *     node_modules/koffi/     prebuilt native addon, pruned to win32_x64
 *     pair.cmd / run.cmd /
 *     doctor.cmd / unpair.cmd double-clickable launchers (args pass through)
 *     SETUP.txt               end-user setup guide
 *     VERSION.txt             version + build stamp
 *
 * Output: <backend>/public/downloads/ezpos-bridge-win64.zip by default — the
 * backend serves it pre-auth at /downloads (see ezPosBackend/src/app.ts) so
 * the pairing dialog can link to it. Override with --out <dir>.
 *
 * Prerequisites: `npm install` in this folder (esbuild + the koffi
 * optionalDependency must both be present).
 *
 * The bundle keeps koffi external on purpose: it is a native addon esbuild
 * cannot inline. The zip ships its prebuilt directory next to bridge.mjs,
 * which createRequire(import.meta.url) resolves at runtime (the adapter's
 * lazy require only fires for spooler printers, so rawTcp-only sites work
 * even if koffi were missing).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const execFileAsync = promisify(execFile);

const bridgeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CRLF = "\r\n";

function parseOutDir(argv) {
  const index = argv.indexOf("--out");
  if (index !== -1 && argv[index + 1]) return path.resolve(argv[index + 1]);
  return path.resolve(bridgeRoot, "..", "ezPosBackend", "public", "downloads");
}

function launcher(command) {
  // %* forwards flags: pair.cmd --backend https://... --name "Counter 1".
  // `pause` keeps the console open after the command ends — double-clicked
  // .cmd windows otherwise close instantly and the result (or error) is
  // never readable.
  return [
    "@echo off",
    `"%~dp0node.exe" "%~dp0bridge.mjs" ${command} %*`,
    "pause",
    "",
  ].join(CRLF);
}

const SETUP_TXT = `ezPos Hardware Bridge - setup
==============================

This folder turns ONE Windows POS machine (receipt printer + cash drawer)
into a registered ezPos terminal. Nothing else needs to be installed on
the machine: node.exe is included.

1) Pair (once per machine)
   - In ezPos: Settings -> Hardware -> "Pair a terminal" -> generate the
     one-time code (valid 10 minutes, single use).
   - Double-click pair.cmd and follow the prompts (backend URL, then the
     code) - or paste the exact "pair.cmd --backend ... --name ..." command
     from the pairing dialog into a terminal opened in this folder.
   - When it succeeds, the terminal shows as "Paired" in ezPos.

2) Run
   - Double-click run.cmd and LEAVE THE WINDOW OPEN: the bridge polls the
     backend for authorized drawer commands every 2 seconds.
   - For always-on operation, create a Task Scheduler task that starts
     run.cmd at logon (Task Scheduler -> Create Task -> Action: Start a
     program -> run.cmd), or register it as a service with NSSM.
   - doctor.cmd checks config, credentials and backend reachability;
     "doctor.cmd --test-tcp" fires one deliberate test drawer kick.

3) Connect the printer / drawer
   - Edit %USERPROFILE%\\.ezpos-bridge\\config.json and list your printer(s)
     under "printers". The FIRST printer in the list is treated as the
     cash drawer. Examples:
       {"kind": "rawTcp",  "name": "Counter thermal", "host": "192.168.1.50", "port": 9100, "pin": 2, "onMs": 50, "offMs": 500}
       {"kind": "spooler", "name": "USB thermal",     "printerName": "POS-80",           "pin": 2, "onMs": 50, "offMs": 500}
     rawTcp  = network printers (ESC/POS drawer kick to TCP 9100)
     spooler = USB printers via the Windows print spooler (printerName is
     exactly what Windows shows; doctor.cmd lists them)
     pin 2 = drawer 1, pin 5 = drawer 2 (clones are sometimes wired to 5).

Notes
- The bridge only makes OUTBOUND connections to your ezPos backend - it
  never opens a port on this machine.
- Drawer commands are authorized and audited by the backend; the bridge
  never creates or changes financial records, and a hardware failure
  never blocks a committed sale.
- unpair.cmd removes this machine's credentials and stops pairing.
`;

async function main() {
  if (process.platform !== "win32") {
    console.error(
      "Build the bridge zip on Windows: the packaged node.exe and the pruned " +
        "koffi addon must match the target machines (win32 x64).",
    );
    process.exit(1);
  }

  const pkg = JSON.parse(
    await readFile(path.join(bridgeRoot, "package.json"), "utf8"),
  );
  const entryPoint = path.join(bridgeRoot, "src", "index.ts");
  const koffiDir = path.join(bridgeRoot, "node_modules", "koffi");
  if (!existsSync(koffiDir)) {
    console.error(
      "node_modules/koffi is missing - run `npm install` in ezPosHardwareBridge first.",
    );
    process.exit(1);
  }

  const outDir = parseOutDir(process.argv);
  const stage = await mkdtemp(path.join(os.tmpdir(), "ezpos-bridge-dist-"));

  try {
    // 1. Single-file ESM bundle; koffi stays external (native addon). ESM is
    // required: spoolerAdapter builds createRequire(import.meta.url), which
    // is empty under CJS output. createRequire still resolves koffi from the
    // zip's node_modules next to bridge.mjs.
    await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: "node",
      format: "esm",
      target: `node${process.versions.node.split(".")[0]}`,
      external: ["koffi"],
      outfile: path.join(stage, "bridge.mjs"),
      sourcemap: false,
      minify: false,
      logLevel: "warning",
    });

    // 2. The exact node.exe this build ran on (same platform/arch).
    await cp(process.execPath, path.join(stage, "node.exe"));

    // 3. koffi prebuilt addon, pruned to the shipping platform.
    const stagedKoffi = path.join(stage, "node_modules", "koffi");
    await cp(koffiDir, stagedKoffi, { recursive: true });
    const buildsDir = path.join(stagedKoffi, "build", "koffi");
    if (existsSync(buildsDir)) {
      for (const platformDir of await readdir(buildsDir)) {
        if (platformDir !== "win32_x64") {
          await rm(path.join(buildsDir, platformDir), { recursive: true });
        }
      }
    }

    // 4. Launchers + docs.
    for (const command of ["pair", "run", "doctor", "unpair"]) {
      await writeFile(
        path.join(stage, `${command}.cmd`),
        launcher(command),
        "utf8",
      );
    }
    await writeFile(path.join(stage, "SETUP.txt"), SETUP_TXT, "utf8");
    await writeFile(
      path.join(stage, "VERSION.txt"),
      [
        `ezpos-hardware-bridge ${pkg.version}`,
        `Built ${new Date().toISOString()}`,
        `Bundled node ${process.version} (win32 x64)`,
        "",
      ].join("\n"),
      "utf8",
    );

    // 5. Zip (Compress-Archive ships with Windows - no extra tooling).
    await mkdir(outDir, { recursive: true });
    const outZip = path.join(outDir, "ezpos-bridge-win64.zip");
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Compress-Archive -Path '${stage}\\*' -DestinationPath '${outZip}' -Force`,
      ],
      { windowsHide: true },
    );

    const { size } = await stat(outZip);
    console.log(`Built ${outZip} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
