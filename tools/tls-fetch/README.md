# Tier 1 TLS helper

This executable uses `github.com/bogdanfinn/tls-client` v1.16.0 with the explicit
`Firefox_148` profile, including its HTTP/2 settings. The Tier 1 user-agent must
match the helper's profile. Camoufox and tiers 0, 2, 3 and 4 are unchanged.
No fingerprint API, generated browser profile or runtime dependency download is
required. This product includes tls-client software developed by Bogdan Finn.

## Build and test

From the repository root with Go 1.27.1 installed:

```sh
bun run build:tls
bun run check:tls
bun test packages/tiers/tests/tlsTransport.test.ts
```

The default binary is `tools/tls-fetch/bin/tls-fetch`; `TLS_FETCH_BINARY` can
override it. Images install it as `/usr/local/bin/clawk-tls-fetch`. The API checks
`--version` before listening when Tier 1 is enabled. Missing or incompatible
binaries never silently fall back to Bun fetch.

## Protocol version 1

Each subprocess accepts one JSON request on stdin: `version`, `url`, `method`,
ordered `headers` pairs, optional base64 `body`, optional `proxy` and PEM `ca`,
`insecure`, and positive `timeoutMs`. Input is limited to 64 MiB. The application
sends its existing UTF-8 request bodies as base64. Credentials never appear in
command arguments or diagnostic output.

Stdout begins with one newline-terminated JSON frame containing `version`, HTTP
`status` and multi-value `headers`, or `error` and `code`. Raw response bytes
follow the frame. EOF with exit status zero completes the response; a nonzero
exit is a failure even after headers arrived. The adapter bounds metadata,
handles cancellation/deadlines and reaps the process. There is no shared cookie
jar, automatic redirect following, implicit decompression or HTTP/3 racing.

HTTPS targets use tls-client, including CONNECT through configured proxies.
Plain HTTP targets behind a proxy use fhttp's absolute-form forward transport,
preserving ordinary HTTP proxy behavior. System roots remain trusted when a
private CA is supplied. Certificate verification is strict unless Tier 1 retries
the specific failing hop after an explicit opt-in.

## Dependency maintenance

Pin dependency updates explicitly, update the profile and static user-agent
together, then run `go mod tidy`, `go mod vendor` and `node notices.mjs` here.
Builds use `-mod=vendor`; check in the updated module checksums and vendor tree.
Do not modify generated vendor sources manually.

Upstream licenses are retained under `vendor/` and reproduced in
`THIRD_PARTY_NOTICES.txt`, which is also distributed with the image. tls-client's
BSD-4-Clause terms include an advertising acknowledgment requirement; retain
the upstream notices and attribution when distributing or describing it.