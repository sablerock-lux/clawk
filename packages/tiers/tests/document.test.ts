import { describe, expect, test } from "bun:test"
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib"
import type { ScrapeResult } from "@trawl/types"
import { scrape } from "../src/orchestrator"
import { DOCUMENT_MAX_BYTES, decodeDocument, documentResponse, readDocument } from "../src/utils/document"

const pdf = Buffer.from([37, 80, 68, 70, 45, 255, 0, 128])
const result: ScrapeResult = {
  url: "https://example.com/document",
  html: "",
  cookies: [],
  userAgent: "test",
  statusCode: 200,
  tier: 1,
  sessionCached: false,
  timings: [],
  totalMs: 1,
  body: pdf,
  contentType: "application/pdf",
}

describe("document response", () => {
  test("an oversized Tier 1 response stops before browser acquisition", async () => {
    let acquired = false
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(new Uint8Array(DOCUMENT_MAX_BYTES + 1)),
    })
    try {
      await expect(
        scrape(
          { url: server.url.href, includeResponseBody: true, maxTier: 3 },
          {
            acquireBrowser: async () => {
              acquired = true
              throw new Error("Unexpected browser")
            },
            releaseBrowser: () => {},
            loadSession: async () => undefined,
            saveSession: async () => {},
            invalidateSession: async () => {},
          },
        ),
      ).rejects.toThrow("retrieval limit")
      expect(acquired).toBe(false)
    } finally {
      server.stop(true)
    }
  })
  test("preserves binary bytes without exposing a typed array", () => {
    const response = documentResponse(result)
    expect(Buffer.from(response.document.data, "base64")).toEqual(pdf)
    expect(response.document.byteLength).toBe(pdf.length)
    expect("body" in response).toBe(false)
  })
  test("decodes supported and stacked encodings", () => {
    for (const [encoding, compressed] of [
      ["gzip", gzipSync(pdf)],
      ["deflate", deflateSync(pdf)],
      ["br", brotliCompressSync(pdf)],
      ["zstd", zstdCompressSync(pdf)],
      ["gzip, br", brotliCompressSync(gzipSync(pdf))],
    ] as const)
      expect(Buffer.from(decodeDocument(compressed, encoding))).toEqual(pdf)
  })
  test("does not decode browser bytes twice and preserves rendered HTML", () => {
    const response = documentResponse({
      ...result,
      tier: 3,
      html: "<p>Rendered</p>",
      responseHeaders: { "content-encoding": "gzip" },
    })
    expect(Buffer.from(response.document.data, "base64")).toEqual(pdf)
    expect(response.html).toBe("<p>Rendered</p>")
  })
  test("rejects missing, malformed, unsupported and oversized bodies", () => {
    expect(() => documentResponse({ ...result, body: undefined })).toThrow("could not be captured")
    expect(() => decodeDocument(pdf, "gzip")).toThrow("Invalid source content encoding")
    expect(() => decodeDocument(pdf, "unknown")).toThrow("Unsupported source content encoding")
    expect(() => decodeDocument(gzipSync(Buffer.alloc(DOCUMENT_MAX_BYTES + 1)), "gzip")).toThrow("retrieval limit")
    expect(() => documentResponse({ ...result, html: "x".repeat(DOCUMENT_MAX_BYTES + 1) })).toThrow("retrieval limit")
  })
  test("bounds streamed input without relying on Content-Length and cancels it", async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(DOCUMENT_MAX_BYTES + 1))
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(readDocument(new Response(stream))).rejects.toThrow("retrieval limit")
    expect(cancelled).toBe(true)
    expect(await readDocument(new Response(pdf))).toEqual(pdf)
  })
})
