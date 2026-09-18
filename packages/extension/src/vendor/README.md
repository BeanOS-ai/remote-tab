---
created: 2026-09-18
last_reviewed: 2026-09-18
---

# Public Suffix List

`public-suffix-rules.json` contains every non-comment, non-blank rule from the
Mozilla Public Suffix List, including ICANN and PRIVATE sections. Rules are
unmodified Unicode strings. `scope.ts` normalizes them through the browser URL
parser and implements exact, wildcard, and exception matching.

Source: https://raw.githubusercontent.com/publicsuffix/list/master/public_suffix_list.dat
Retrieved: 2026-09-18.
Upstream source SHA-256: `b5318da43cf23b0aeca01125b220cfe39ecf108fc72d959d1bc5cda5ace7a761`.
The normal distribution endpoint (`https://publicsuffix.org/list/public_suffix_list.dat`)
was unavailable from the build environment; the upstream project's GitHub mirror
was used. The source checksum identifies the precise snapshot.

To update, download the upstream list, remove blank lines and lines beginning
with `//`, serialize the remaining trimmed strings as a JSON array, and run the
repository formatter. Record the new retrieval date and source checksum here.
The bundled data is licensed under MPL-2.0; see `PSL-LICENSE`. Other extension
source code retains the repository's MIT license.
