import { Firestore } from "@google-cloud/firestore";
import { GoogleAuth } from "google-auth-library";
import { GcsBlobStore } from "./blob-store";
import { GcpStore, validateGcpActiveMax } from "./firestore-store";

export interface CreateGcpStoreOptions {
  bucket: string;
  databaseId?: string;
  activeMax?: number;
}

/** Called only after explicit GCP selection; both clients use ADC. */
export async function createGcpStore(options: CreateGcpStoreOptions): Promise<GcpStore> {
  validateGcpActiveMax(options.activeMax ?? 500);
  if (!options.bucket.trim()) throw new Error("REMOTE_TAB_GCS_BUCKET is required");
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/devstorage.read_write"],
  });
  const blobs = new GcsBlobStore({
    bucket: options.bucket,
    token: async () => {
      const token = await auth.getAccessToken();
      if (!token) throw new Error("GCS application credentials are unavailable");
      return token;
    },
  });
  return new GcpStore({
    firestore: new Firestore({ databaseId: options.databaseId ?? "(default)" }),
    blobs,
  });
}
