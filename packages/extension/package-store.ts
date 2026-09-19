import { link, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EXTENSION_VERSION, STORE_FILES, serverOrigin } from "./build";

export function releaseOrigin(value: string | undefined): string {
  const invalid = () =>
    new Error(
      "Set REMOTE_TAB_SERVER_ORIGIN to the release HTTPS origin; placeholder and development origins cannot be packaged.",
    );
  if (!value) throw invalid();
  let origin: string;
  try {
    origin = serverOrigin(value);
  } catch {
    throw invalid();
  }
  const url = new URL(origin);
  const hostname = url.hostname.replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    hostname === "remote-tab.example" ||
    ["localhost", "[::1]"].includes(hostname) ||
    hostname.endsWith(".localhost") ||
    /^127(?:\.\d+){3}$/.test(hostname)
  )
    throw invalid();
  return origin;
}

// ZIP metadata and file order are fixed, rather than inherited from source mtimes.
// Python's standard library provides ZIP/CRC support without installing a dependency.
const archiveScript = `
import pathlib, sys, zipfile
root, destination, *files = sys.argv[1:]
with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name in files:
        source = pathlib.Path(root, name)
        if not source.is_file() or source.is_symlink():
            raise RuntimeError("Missing or unsafe runtime file: " + name)
        info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, source.read_bytes(), compresslevel=9)
`;

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { cwd: import.meta.dir, stdout: "ignore", stderr: "pipe" });
  const [exitCode, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`Package creation failed: ${error.trim()}`);
}

async function checkOutput(output: string, force: boolean): Promise<void> {
  if (!output.endsWith(".zip")) throw new Error("The package output must end in .zip");
  const existing = await lstat(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!existing) return;
  if (!existing.isFile() || existing.isSymbolicLink())
    throw new Error(
      "The package output must be a regular file, never a directory or symbolic link",
    );
  if (!force) throw new Error("The package output already exists; use --force to replace it");
}

/** Fresh build, explicit allowlist, and atomic publication. No store upload is performed. */
export async function packageStore(
  options: { origin?: string; output?: string; force?: boolean } = {},
): Promise<string> {
  const origin = releaseOrigin(options.origin ?? process.env.REMOTE_TAB_SERVER_ORIGIN);
  const output = resolve(
    options.output ?? join(import.meta.dir, `../../dist/remote-tab-${EXTENSION_VERSION}.zip`),
  );
  const force = options.force ?? false;
  await checkOutput(output, force);
  await mkdir(dirname(output), { recursive: true });
  const temporary = await mkdtemp(join(dirname(output), ".remote-tab-"));
  try {
    const built = join(temporary, "extension");
    // A fresh compiler process also isolates Bun's module/file caches from
    // callers that already imported client code or performed another build.
    await run([
      process.execPath,
      "--eval",
      'const { buildExtension } = await import("./build.ts"); await buildExtension(process.argv[1], process.argv[2]);',
      origin,
      built,
    ]);
    const archive = join(temporary, "release.zip");
    await run(["python3", "-c", archiveScript, built, archive, ...STORE_FILES]);
    await checkOutput(output, force);
    if (force) await rename(archive, output);
    else await link(archive, output); // Exclusive: a concurrent producer cannot be overwritten.
    return output;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.includes("--help")) {
      console.log(
        "Usage: REMOTE_TAB_SERVER_ORIGIN=https://server.example package-store.sh [output.zip] [--force]",
      );
    } else {
      const outputs = args.filter((arg) => arg !== "--force");
      if (outputs.length > 1 || outputs.some((arg) => arg.startsWith("-")))
        throw new Error("Usage: package-store.sh [output.zip] [--force]");
      console.log(await packageStore({ output: outputs[0], force: args.includes("--force") }));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Package creation failed");
    process.exitCode = 1;
  }
}
