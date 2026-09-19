/** Blob paths include the session incarnation; the owner supplies absolute retention metadata. */
export interface BlobStore {
  put(path: string, bytes: Uint8Array<ArrayBuffer>, customTime: Date | string): Promise<void>;
  get(path: string): Promise<Uint8Array<ArrayBuffer> | null>;
}

export class BlobAlreadyExists extends Error {
  constructor() {
    super("blob already exists");
    this.name = "BlobAlreadyExists";
  }
}

export class BlobStoreError extends Error {
  constructor() {
    super("blob storage unavailable");
    this.name = "BlobStoreError";
  }
}

export interface GcsBlobStoreOptions {
  bucket: string;
  token: () => Promise<string>;
  fetch?: (request: Request) => Promise<Response>;
}

/** GCS holds immutable ciphertext only. Each upload commits metadata and bytes together. */
export class GcsBlobStore implements BlobStore {
  private readonly fetcher: (request: Request) => Promise<Response>;
  constructor(private readonly options: GcsBlobStoreOptions) {
    if (!options.bucket) throw new Error("blob bucket is required");
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async put(
    path: string,
    bytes: Uint8Array<ArrayBuffer>,
    customTime: Date | string,
  ): Promise<void> {
    try {
      if (!path) throw new BlobStoreError();
      const timestamp = new Date(customTime).toISOString();
      const boundary = `remote-tab-${crypto.randomUUID()}`;
      const metadata = JSON.stringify({
        name: path,
        contentType: "application/octet-stream",
        customTime: timestamp,
      });
      // Blob snapshots mutable caller bytes before awaiting token acquisition.
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
        `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
        bytes,
        `\r\n--${boundary}--\r\n`,
      ]);
      const url = new URL(
        `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.options.bucket)}/o`,
      );
      url.searchParams.set("uploadType", "multipart");
      url.searchParams.set("ifGenerationMatch", "0");
      const response = await this.fetcher(
        new Request(url, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${await this.options.token()}`,
            "Content-Type": `multipart/related; boundary=${boundary}`,
            "Content-Length": String(body.size),
          },
          body,
        }),
      );
      void response.body?.cancel().catch(() => {});
      if (response.status === 412) throw new BlobAlreadyExists();
      if (!response.ok) throw new BlobStoreError();
    } catch (error) {
      // Neither provider diagnostics nor object paths/credentials cross this boundary.
      if (error instanceof BlobAlreadyExists) throw error;
      throw new BlobStoreError();
    }
  }

  async get(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
    try {
      if (!path) throw new BlobStoreError();
      const url = new URL(
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.options.bucket)}/o/${encodeURIComponent(path)}`,
      );
      url.searchParams.set("alt", "media");
      const response = await this.fetcher(
        new Request(url, {
          redirect: "error",
          headers: { Authorization: `Bearer ${await this.options.token()}` },
        }),
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 404) return null;
        throw new BlobStoreError();
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new BlobStoreError();
    }
  }
}
