import { expect, test } from "bun:test";
import { BlobAlreadyExists, BlobStoreError, GcsBlobStore } from "./blob-store";

const path = "sessions/test-session/test-incarnation/blobs/test-blob";
const customTime = new Date("2026-09-19T01:00:00.000Z");
const bytes = new Uint8Array([0, 255, 128, 10, 13, 45, 45, 1]);

function adapter(fetch: (request: Request) => Promise<Response>) {
  return new GcsBlobStore({ bucket: "test-bucket", token: async () => "test-token", fetch });
}

function multipart(request: Request, body: Buffer) {
  const boundary = request.headers.get("content-type")?.split("boundary=")[1];
  expect(boundary).toBeTruthy();
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
  );
  const middle = Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  expect(body.subarray(0, prefix.length)).toEqual(prefix);
  expect(body.subarray(-suffix.length)).toEqual(suffix);
  const split = body.indexOf(middle);
  expect(split).toBeGreaterThan(prefix.length);
  return {
    metadata: JSON.parse(body.subarray(prefix.length, split).toString("utf8")),
    payload: body.subarray(split + middle.length, -suffix.length),
  };
}

test("create-only multipart atomically includes retention metadata and exact ciphertext", async () => {
  let calls = 0;
  const store = adapter(async (request) => {
    calls++;
    const url = new URL(request.url);
    expect(request.method).toBe("POST");
    expect(url.origin).toBe("https://storage.googleapis.com");
    expect(url.pathname).toBe("/upload/storage/v1/b/test-bucket/o");
    expect(url.searchParams.get("uploadType")).toBe("multipart");
    expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
    expect(request.headers.get("authorization")).toBe("Bearer test-token");
    expect(request.redirect).toBe("error");
    const body = Buffer.from(await request.arrayBuffer());
    expect(Number(request.headers.get("content-length"))).toBe(body.length);
    const parsed = multipart(request, body);
    expect(parsed.metadata).toEqual({
      name: path,
      customTime: customTime.toISOString(),
      contentType: "application/octet-stream",
    });
    expect(parsed.payload).toEqual(Buffer.from(bytes));
    return Response.json({ generation: "1" });
  });
  await store.put(path, bytes, customTime);
  expect(calls).toBe(1);
});

test("upload snapshots caller bytes before asynchronous token acquisition", async () => {
  let finish!: (token: string) => void;
  const mutable = bytes.slice();
  const store = new GcsBlobStore({
    bucket: "test",
    token: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    fetch: async (request) => {
      expect(multipart(request, Buffer.from(await request.arrayBuffer())).payload).toEqual(
        Buffer.from(bytes),
      );
      return new Response(null, { status: 200 });
    },
  });
  const pending = store.put(path, mutable, customTime.toISOString());
  mutable.fill(42);
  finish("test-token");
  await pending;
});

test("412 is an explicit collision, never an overwrite or successful retry", async () => {
  let calls = 0;
  const store = adapter(async () => {
    calls++;
    return new Response("private provider detail", { status: 412 });
  });
  await expect(store.put(path, bytes, customTime)).rejects.toBeInstanceOf(BlobAlreadyExists);
  expect(calls).toBe(1);
});

test("reads encode the entire path and return exact bytes; 404 means absent", async () => {
  const specialPath = `${path}?token=not-a-query#fragment`;
  const store = adapter(async (request) => {
    const url = new URL(request.url);
    expect(request.method).toBe("GET");
    expect(url.pathname).toBe(`/storage/v1/b/test-bucket/o/${encodeURIComponent(specialPath)}`);
    expect([...url.searchParams]).toEqual([["alt", "media"]]);
    expect(request.headers.get("authorization")).toBe("Bearer test-token");
    expect(request.redirect).toBe("error");
    return new Response(bytes);
  });
  expect(await store.get(specialPath)).toEqual(bytes);
  expect(await adapter(async () => new Response(null, { status: 404 })).get(path)).toBeNull();
});

test("provider errors, failed token acquisition and broken body reads are sanitized", async () => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    let calls = 0;
    const store = adapter(async () => {
      calls++;
      return new Response("private provider diagnostic", { status });
    });
    await expect(store.put(path, bytes, customTime)).rejects.toThrow("blob storage unavailable");
    await expect(store.get(path)).rejects.toThrow("blob storage unavailable");
    expect(calls).toBe(2);
  }
  const broken = adapter(async () => {
    throw new Error("private transport diagnostic");
  });
  await expect(broken.get(path)).rejects.toBeInstanceOf(BlobStoreError);
  await expect(broken.put(path, bytes, customTime)).rejects.toBeInstanceOf(BlobStoreError);
  const credentials = new GcsBlobStore({
    bucket: "test",
    token: async () => {
      throw new Error("private credential diagnostic");
    },
    fetch: async () => {
      throw new Error("should not fetch");
    },
  });
  await expect(credentials.put(path, bytes, customTime)).rejects.toThrow(
    "blob storage unavailable",
  );
  await expect(credentials.get(path)).rejects.toThrow("blob storage unavailable");
  const bodyError = adapter(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error("private body diagnostic"));
          },
        }),
      ),
  );
  await expect(bodyError.get(path)).rejects.toThrow("blob storage unavailable");
});

test("invalid retention timestamp cannot upload an object missing cleanup metadata", async () => {
  let calls = 0;
  const store = adapter(async () => {
    calls++;
    return new Response();
  });
  await expect(store.put(path, bytes, "not-a-date")).rejects.toBeInstanceOf(BlobStoreError);
  expect(calls).toBe(0);
});
