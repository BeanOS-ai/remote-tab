import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageStore, releaseOrigin } from "./package-store";

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "remote-tab-store-test-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const origin = "https://release.example:8443";
const expectedFiles = [
  "LICENSE",
  "bean-creature.svg",
  "icons/icon128.png",
  "icons/icon16.png",
  "icons/icon48.png",
  "ledger.css",
  "ledger.html",
  "ledger.js",
  "manifest.json",
  "popup.html",
  "popup.js",
  "style.css",
  "vendor/PSL-LICENSE",
  "vendor/README.md",
  "vendor/public-suffix-rules.json",
  "worker.js",
].sort();
const inspectScript = `
import base64, binascii, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert archive.testzip() is None
    result = []
    for info in archive.infolist():
        data = archive.read(info.filename)
        assert info.CRC == binascii.crc32(data) & 0xffffffff
        result.append({"name": info.filename, "size": info.file_size, "date": info.date_time, "permissions": info.external_attr >> 16, "data": base64.b64encode(data).decode("ascii")})
    print(json.dumps(result))
`;
interface Member {
  name: string;
  size: number;
  date: number[];
  permissions: number;
  data: string;
}
async function inspect(output: string): Promise<Member[]> {
  const child = Bun.spawn(["python3", "-c", inspectScript, output], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, result, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(error).toBe("");
  expect(code).toBe(0);
  return JSON.parse(result);
}
const bytes = (members: Member[], name: string) => {
  const member = members.find((member) => member.name === name);
  if (!member) throw new Error(`Missing archive member ${name}`);
  return Buffer.from(member.data, "base64");
};

test("release origin is explicit HTTPS and cannot use the placeholder or development origin", () => {
  expect(releaseOrigin(`${origin}/`)).toBe(origin);
  for (const value of [
    undefined,
    "",
    "https://remote-tab.example",
    "https://remote-tab.example.",
    "https://remote-tab.example:8443",
    "http://127.0.0.1:3000",
    "https://localhost",
    "https://tool.localhost",
    "https://127.0.0.2",
    "http://release.example",
    "https://user:password@release.example",
    "https://release.example/path",
    "https://release.example/?key=value",
    "https://release.example/#fragment",
    "https://*.release.example",
    "file:///tmp/release",
  ])
    expect(() => releaseOrigin(value)).toThrow("release HTTPS origin");
});

test("store ZIP has the exact runtime allowlist, valid CRCs, published icons, permissions and corresponding license sources", async () => {
  const root = await directory();
  const output = await packageStore({ origin, output: join(root, "store.zip") });
  const members = await inspect(output);
  expect(members.map((file) => file.name)).toEqual(expectedFiles);
  for (const file of members) {
    expect(file.date).toEqual([1980, 1, 1, 0, 0, 0]);
    expect(file.permissions).toBe(0o100644);
    expect(file.size).toBeGreaterThan(0);
    expect(file.name).not.toMatch(
      /(?:^|\/)(?:node_modules|\.env|src|tests)\b|\.(?:map|ts|test\.js)$/,
    );
  }
  const manifest = JSON.parse(bytes(members, "manifest.json").toString());
  expect(manifest.name).toBe("Bean Tab Share");
  expect(manifest.version).toBe("2.1.0");
  expect(manifest.version).toBe(
    (await Bun.file(join(import.meta.dir, "package.json")).json()).version,
  );
  expect(manifest.permissions).toEqual(["tabs", "debugger"]);
  expect(manifest.host_permissions).toEqual([`${origin}/*`]);
  expect(manifest.background).toEqual({ service_worker: "worker.js", type: "module" });
  expect(manifest.minimum_chrome_version).toBe("125");
  expect(manifest.content_security_policy.extension_pages).toBe(
    "script-src 'self'; object-src 'none'",
  );
  for (const size of [16, 48, 128]) {
    const path = `icons/icon${size}.png`;
    expect(manifest.icons[size]).toBe(path);
    expect(manifest.action.default_icon[size]).toBe(path);
    const png = bytes(members, path);
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
    expect(png).toEqual(Buffer.from(await Bun.file(join(import.meta.dir, path)).arrayBuffer()));
  }
  expect(bytes(members, "LICENSE").toString()).toBe(
    await Bun.file(join(import.meta.dir, "../../LICENSE")).text(),
  );
  for (const name of ["PSL-LICENSE", "README.md", "public-suffix-rules.json"])
    expect(bytes(members, `vendor/${name}`).toString()).toBe(
      await Bun.file(join(import.meta.dir, "src/vendor", name)).text(),
    );
  const worker = bytes(members, "worker.js").toString();
  expect(bytes(members, "bean-creature.svg").toString()).toBe(
    await Bun.file(join(import.meta.dir, "bean-creature.svg")).text(),
  );
  expect(worker).toContain(origin);
  expect(worker).not.toContain("https://remote-tab.example");
  expect(worker).not.toContain("storage.googleapis.com");
  expect(await readdir(root)).toEqual(["store.zip"]);
});

test("fresh packages are byte-identical despite file timestamps and ignore stale output artifacts", async () => {
  const root = await directory();
  await mkdir(join(root, "extension"));
  await Bun.write(join(root, "extension/.env"), "not runtime");
  await Bun.write(join(root, "extension/worker.js"), "stale worker");
  const first = await packageStore({ origin, output: join(root, "first.zip") });
  await utimes(first, new Date(0), new Date(0));
  const second = await packageStore({ origin, output: join(root, "second.zip") });
  expect(await Bun.file(first).bytes()).toEqual(await Bun.file(second).bytes());
  const members = await inspect(second);
  expect(members.map((file) => file.name)).toEqual(expectedFiles);
  expect(bytes(members, "worker.js").toString()).not.toContain("stale worker");
});

test("existing output requires force; directories, symlinks and non-ZIP targets are never overwritten", async () => {
  const root = await directory();
  const output = join(root, "store.zip");
  await Bun.write(output, "previous archive");
  await expect(packageStore({ origin, output })).rejects.toThrow("already exists");
  expect(await Bun.file(output).text()).toBe("previous archive");
  await packageStore({ origin, output, force: true });
  expect((await inspect(output)).map((file) => file.name)).toEqual(expectedFiles);
  const target = join(root, "protected.zip");
  await Bun.write(target, "keep this file");
  const link = join(root, "symlink.zip");
  await symlink(target, link);
  await expect(packageStore({ origin, output: link, force: true })).rejects.toThrow("regular file");
  expect(await Bun.file(target).text()).toBe("keep this file");
  const folder = join(root, "directory.zip");
  await mkdir(folder);
  await expect(packageStore({ origin, output: folder, force: true })).rejects.toThrow(
    "regular file",
  );
  await expect(
    packageStore({ origin, output: join(root, "source.ts"), force: true }),
  ).rejects.toThrow("end in .zip");
  expect((await readdir(root)).filter((name) => name.startsWith(".bean-tab-share-"))).toEqual([]);
});

test("shell entrypoint rejects missing release origin before touching output", async () => {
  const root = await directory();
  const output = join(root, "release.zip");
  const env = { ...process.env };
  env.REMOTE_TAB_SERVER_ORIGIN = undefined;
  const child = Bun.spawn(["bash", join(import.meta.dir, "package-store.sh"), output], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(error).toContain("Set REMOTE_TAB_SERVER_ORIGIN");
  expect(await readdir(root)).toEqual([]);
});
