# Optional GCP store contract

This is the approved-design target for the adapter implementation that follows
this document. The default server uses `MemoryStore`; no cloud service is
required. `REMOTE_TAB_STORE=gcp` opts into `packages/store-gcp` using the official
`@google-cloud/firestore` client and Application Default Credentials. Select a
Firestore database with `REMOTE_TAB_FIRESTORE_DATABASE` (default `(default)`)
and a blob bucket with `REMOTE_TAB_GCS_BUCKET`. Unknown store names fail startup.
Cloud clients load only in GCP mode. The adapter and this contract contain no
deployment-specific project, domain, or tier policy.

## Layout and atomicity

- `sessions/{id}`: one session document, the existing record plus an internal
  random incarnation and Timestamp `delete_at`. Platform keys remain hashed;
  session encryption secrets never enter any store.
- `sessions/{id}/messages/{incarnation}_{padded-seq}`: immutable ciphertext
  message and its own Timestamp `delete_at`. Query the current incarnation's
  document-ID range in sequence order. This uses the built-in document-ID index.
- `admission/active`: bounded active-session lease map, excluded from TTL and
  field indexing. At most 1,000 configured global slots; larger settings fail
  startup. Lease entries contain fixed-shape ID, client IP, and expiry.
- GCS `sessions/{id}/{incarnation}/blobs/{blob_id}`: immutable ciphertext only.
  No state JSON, message pointers, admission objects, or raw keys in GCS.

Session creation and its lease commit together, with create-only session-ID
semantics. Admission prunes expired leases and enforces global/per-IP caps in
the same transaction. Stop removes a lease; Extend updates lease and session
expiry together. Expired leases do not depend on asynchronous TTL deletion.

Append reads the session in a Firestore transaction, checks active state and
current time on every attempt, validates the predecessor hash and message cap,
and creates the message while advancing the chain head atomically. The existing
`Store` interface and shared error types remain the adapter boundary. Transaction
callbacks may rerun: `hashFor` and `mutate` must have no external side effects.
MemoryStore follows the same logical expiry and concurrency contract.

Long-poll listens to the session head with `onSnapshot`, including the initial
snapshot to close the read/listen race. It wakes on head advance, stop, deletion,
expiry, or timeout; listener errors reject. Every path unsubscribes and clears
timers. Extend snapshots rearm expiry to the latest deadline. Request cancellation
unsubscribes where available; otherwise the 25-second bound applies. The HTTP
layer rereads committed messages after waking.

Blob writes reserve cumulative bytes transactionally while active, then upload
outside the transaction with `ifGenerationMatch=0`. Reservation is the operation's
authorization point: a later Stop may leave an unreferenced ciphertext object.
Failed or ambiguous uploads consume their reserved budget; they are never
silently overwritten or retried as successful writes. QPS remains per instance;
only session admission and lifetime resource budgets are shared by this store.

## Retention and provisioning

Enable Firestore TTL on Timestamp `delete_at` for both collection groups
`sessions` and `messages`. Session deletion eligibility is actual expiry +24h,
updated atomically on Extend. Parent deletion does not delete subcollections.
Immutable child retention uses session `createdAt` +60min +24h, covering every permitted
Extend without non-atomic bulk rewrites. For a 60-second session, this retains
children up to 59 minutes beyond its minimum window. A new incarnation prevents
old children from becoming visible if the parent ID is reused after deletion.

Set each blob's `Custom-Time` to session `createdAt` +60min in the same create-only upload.
Configure the bucket lifecycle to delete the `sessions/` prefix when
`daysSinceCustomTime` is 1. The boundary is eligibility, not guaranteed physical
erasure. TTL/lifecycle cleanup is asynchronous. Choose soft-delete, versioning,
retention, legal-hold, and backup policies deliberately; these can retain data
longer. Exempt message ciphertext, TTL fields, and the admission map from field
indexes. Use consistent caps across instances and IAM credentials with only the
required Firestore data and bucket object access.

Switching from `REMOTE_TAB_STORE=gcs` requires stopping old writers and allowing
existing sessions to finish before selecting `gcp`. There is no state migration,
dual-read fallback, or coexistence guarantee. Retain the old bucket's cleanup
policy until old objects are gone; configure the new blob-only policy separately.

## Validation

Share a store contract suite between MemoryStore and the emulator-backed adapter:
create/duplicate ID, compare-and-swap update, concurrent append, predecessor
mismatch, caps, stop/expiry, messages and blobs, listener wake-up and timeout.
Use an injected clock for logical expiry and two independent clients for races.
Test GCS create-only uploads, metadata, errors, and budget reservation with
injected fetch; no cloud credentials or live resources are needed.

The Firestore suite requires `FIRESTORE_EMULATOR_HOST` and a synthetic project ID.
CI provisions Java and the official emulator and runs it as a separate job. Local
runs without the emulator explicitly skip that integration suite; shared memory
and injected-blob tests still run. A configured emulator's assertion failures
must fail. Test TTL field values and expiry behavior, not asynchronous service
cleanup. Emulator coverage does not prove production indexes, limits, or IAM.

References: [Firestore transactions](https://docs.cloud.google.com/firestore/native/docs/manage-data/transactions),
[Firestore listeners](https://docs.cloud.google.com/firestore/native/docs/query-data/listen),
[Firestore TTL](https://firebase.google.com/docs/firestore/ttl),
[GCS lifecycle](https://docs.cloud.google.com/storage/docs/lifecycle), and
[emulator setup](https://docs.cloud.google.com/firestore/native/docs/emulator).
