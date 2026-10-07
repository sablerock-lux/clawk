import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { runTier1 } from "../src/tiers/1"
import { tlsFetch, verifyTlsHelper } from "../src/utils/tlsTransport"

async function withHelper(source: string, check: () => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "tls-helper-test-"))
  const binary = join(directory, "helper")
  const original = process.env.TLS_FETCH_BINARY
  writeFileSync(binary, `#!${process.execPath}\n${source}\n`)
  chmodSync(binary, 0o755)
  process.env.TLS_FETCH_BINARY = binary
  try {
    await check()
  } finally {
    if (original === undefined) delete process.env.TLS_FETCH_BINARY
    else process.env.TLS_FETCH_BINARY = original
    rmSync(directory, { recursive: true, force: true })
  }
}

describe("TLS helper subprocess", () => {
  test("validates the compiled profile at startup", () => {
    expect(verifyTlsHelper).not.toThrow()
  })

  test("rejects malformed and oversized metadata without fallback", async () => {
    for (const source of ['process.stdout.write("not json\\n")', 'process.stdout.write("x".repeat(270000))']) {
      await withHelper(source, async () => {
        await expect(tlsFetch("https://example.invalid")).rejects.toThrow()
      })
    }
  })

  test("reports a helper crash after headers as a body failure", async () => {
    await withHelper(
      'process.stdout.write(JSON.stringify({version:1,status:200,headers:{}})+"\\npartial", () => process.exit(1))',
      async () => {
        const response = await tlsFetch("https://example.invalid")
        await expect(response.arrayBuffer()).rejects.toThrow("interrupted")
      },
    )
  })

  test("terminates a stalled helper on deadline", async () => {
    await withHelper("setInterval(() => {}, 1000)", async () => {
      await expect(tlsFetch("https://example.invalid", { timeoutMs: 100 })).rejects.toThrow("timed out")
    })
  })

  test("fails clearly for incompatible startup metadata", async () => {
    await withHelper("process.stdout.write(JSON.stringify({version:0}))", async () => {
      expect(verifyTlsHelper).toThrow("missing or incompatible")
    })
  })

  test("fails without fallback when the helper is missing", async () => {
    await withHelper("", async () => {
      process.env.TLS_FETCH_BINARY += ".missing"
      expect(verifyTlsHelper).toThrow("missing or incompatible")
      await expect(tlsFetch("https://example.invalid")).rejects.toThrow()
    })
  })

  test("rejects an already aborted request", async () => {
    await expect(tlsFetch("https://example.invalid", { signal: AbortSignal.abort() })).rejects.toThrow("aborted")
  })

  test("reaps a helper when its response is aborted or exceeds its deadline", async () => {
    const source = `process.stdout.write(JSON.stringify({version:1,status:200,headers:{"x-helper-pid":[String(process.pid)]}})+"\\n"); setInterval(() => {}, 1000)`
    await withHelper(source, async () => {
      for (const mode of ["abort", "deadline", "cancel"]) {
        const controller = new AbortController()
        const response = await tlsFetch("https://example.invalid", {
          signal: controller.signal,
          timeoutMs: mode === "deadline" ? 300 : 5000,
        })
        const pid = Number(response.headers.get("x-helper-pid"))
        expect(pid).toBeGreaterThan(0)
        if (mode === "cancel") {
          await response.body?.cancel()
        } else {
          if (mode === "abort") controller.abort()
          await expect(response.arrayBuffer()).rejects.toThrow("interrupted")
        }
        expect(() => process.kill(pid, 0)).toThrow()
      }
    })
  })

  test("keeps gzip bytes encoded while Tier 1 inspects decoded text", async () => {
    const encoded = gzipSync("hello from gzip")
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(encoded, { headers: { "content-encoding": "gzip", "content-type": "text/plain" } }),
    })
    try {
      const result = await runTier1(server.url.href)
      expect(result.status).toBe("success")
      expect(result.html).toBe("hello from gzip")
      expect(result.body).toEqual(new Uint8Array(encoded))
      expect(result.responseHeaders?.["content-encoding"]).toBe("gzip")
    } finally {
      server.stop(true)
    }
  })

  test("validates redirect hops and strips credentials without replaying response cookies", async () => {
    const destination = Bun.serve({
      port: 0,
      async fetch(request) {
        return Response.json({
          authorization: request.headers.get("authorization"),
          cookie: request.headers.get("cookie"),
          contentType: request.headers.get("content-type"),
          method: request.method,
          body: await request.text(),
        })
      },
    })
    const origin = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: { location: destination.url.href, "set-cookie": "session=upstream" },
        }),
    })
    try {
      const validated: string[] = []
      const result = await runTier1(
        origin.url.href,
        { authorization: "Bearer caller", cookie: "session=caller", "content-type": "text/plain" },
        "POST",
        "payload",
        undefined,
        async (url) => {
          validated.push(url)
        },
      )
      expect(result.status).toBe("success")
      expect(validated).toEqual([origin.url.href, destination.url.href])
      expect(JSON.parse(result.html ?? "")).toEqual({
        authorization: null,
        cookie: null,
        contentType: null,
        method: "GET",
        body: "",
      })
    } finally {
      origin.stop(true)
      destination.stop(true)
    }
  })

  test("returns duplicate cookies and binary bytes without following redirects", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/redirect")
          return new Response(null, { status: 302, headers: { location: "/body" } })
        const headers = new Headers()
        headers.append("set-cookie", "one=1")
        headers.append("set-cookie", "two=2")
        return new Response(new Uint8Array([0, 255, 1]), { headers })
      },
    })
    try {
      const redirect = await tlsFetch(`${server.url}redirect`)
      expect(redirect.status).toBe(302)
      await redirect.body?.cancel()
      const response = await tlsFetch(`${server.url}body`)
      expect(response.headers.getSetCookie()).toEqual(["one=1", "two=2"])
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 1]))
      const result = await runTier1(`${server.url}redirect`)
      expect(result.status).toBe("success")
      expect(result.effectiveUrl).toBe(`${server.url}body`)
      expect(result.body).toEqual(new Uint8Array([0, 255, 1]))
    } finally {
      server.stop(true)
    }
  })

  test("returns headers before a hanging body and supports cancellation", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]))
            },
          }),
          {
            status: 202,
            headers: { "x-amzn-waf-action": "challenge" },
          },
        )
      },
    })
    try {
      const response = await tlsFetch(server.url.href, { timeoutMs: 1500 })
      expect(response.headers.get("x-amzn-waf-action")).toBe("challenge")
      await response.body?.cancel()
      const result = await runTier1(server.url.href)
      expect(result.reason).toBe("aws-waf-challenge")
    } finally {
      server.stop(true)
    }
  })
})
