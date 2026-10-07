import { afterEach, describe, expect, test } from "bun:test"
import { rootCertificates } from "node:tls"
import { runTier1 } from "../src/tiers/1"
import { tier1Transport } from "../src/utils/tlsTransport"

const originalFetch = tier1Transport.fetch

afterEach(() => {
  tier1Transport.fetch = originalFetch
})

describe("trusted proxy CA", () => {
  test("adds the private CA alongside public roots for only that fetch", async () => {
    let options: Parameters<typeof fetch>[1]
    tier1Transport.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      options = init
      return new Response("Pong", { headers: { "content-type": "text/plain" } })
    }) as typeof fetch

    const result = await runTier1(
      "https://target.example/ping",
      undefined,
      "GET",
      undefined,
      "http://127.0.0.1:8192",
      undefined,
      false,
      "TRAWL PRIVATE CA",
    )

    expect(result.status).toBe("success")
    const ca = (options as RequestInit & { tls?: { ca?: string[] } }).tls?.ca
    expect(ca).toContain("TRAWL PRIVATE CA")
    expect(ca).toContain(rootCertificates[0])
  })

  test("does not alter TLS options without recognized local proxy trust", async () => {
    let options: Parameters<typeof fetch>[1]
    tier1Transport.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      options = init
      return new Response("Pong", { headers: { "content-type": "text/plain" } })
    }) as typeof fetch

    await runTier1("https://target.example/ping", undefined, "GET", undefined, "http://proxy.example:8080")
    expect((options as RequestInit & { tls?: unknown }).tls).toBeUndefined()
  })
})
