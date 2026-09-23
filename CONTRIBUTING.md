---
created: 2026-09-23
last_updated: 2026-09-23
last_reviewed: 2026-09-23
---

# Contributing

Remote Tab is MIT-licensed: you are welcome to read, fork, and build on it.
Bug reports and proposals are welcome. **Outside pull requests are not yet
accepted** while the maintainers establish contribution review and support.
Please open an issue to discuss a change before preparing a pull request;
unsolicited outside pull requests may be closed without review.

## Report a bug or propose an improvement

Use the [issue templates](https://github.com/BeanOS-ai/remote-tab/issues/new/choose).
Include the version or commit, browser and operating system, a minimal
reproduction, and what you expected to happen. Use synthetic pages or redact
private page content; never attach credentials, pairing codes, or live session
state. For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead.

## Work on a fork or an invited change

See the [development guide](docs/development.md) for setup and verification.
Keep each change focused, explain the user-visible effect, and report the checks
run. Documentation examples should use environment variables and generic
origins. Keep production configuration and secrets outside this repository.

Before submitting an invited change, run:

```sh
bun install --frozen-lockfile
bun run build
bun run test
bun run check
bunx tsc -p tsconfig.json
```

Use Bun 1.4.2. Browser-facing changes also need the relevant Chromium checks
and manual acceptance steps in the development guide.

This file will be updated when outside contributions open, with the review
process and contribution terms.
