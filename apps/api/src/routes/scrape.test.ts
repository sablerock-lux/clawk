import { describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import { DocumentError, type OrchestratorDeps } from "@trawl/tiers"
import type { ScrapeResult, SessionData } from "@trawl/types"
import { MetricsStore } from "../metrics"
import { scrapeRoute } from "./scrape"

const WALL_HTML = `<html><head><title>Access denied</title></head><body><h1>403</h1>${"blocked ".repeat(40)}</body></html>`
const JPEG_BASE64 = Buffer.from("fake-jpeg-bytes").toString("base64")

const session: SessionData = { cookies: [], userAgent: "cached-user-agent", savedAt: 1 }

const mainFrame = {}
const wallPage = {
  url: () => "https://example.com/blocked",
  title: async () => "Access denied",
  content: async () => WALL_HTML,
  goto: async () => {},
  on: (event: string, handler: (response: unknown) => void) => {
    if (event !== "response") return
    handler({
      url: () => "https://example.com/blocked",
      status: () => 403,
      headers: () => ({}),
      body: async () => Buffer.from(WALL_HTML),
      request: () => ({ isNavigationRequest: () => true, frame: () => mainFrame }),
    })
  },
  off: () => {},
  once: () => {},
  mainFrame: () => mainFrame,
  frames: () => [],
  context: () => ({ cookies: async () => [] }),
  evaluate: async () => "test-agent",
  setExtraHTTPHeaders: async () => {},
  waitForLoadState: async () => {},
  close: async () => {},
  screenshot: async () => Buffer.from("fake-jpeg-bytes"),
}

const blockedDeps = (): OrchestratorDeps => ({
  acquireBrowser: async () =>
    ({
      id: 1,
      lease: 1,
      headful: false,
      context: { newPage: async () => wallPage, addCookies: async () => {}, cookies: async () => [] },
      browser: {},
      fingerprint: { userAgent: "test-agent", platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
    }) satisfies BrowserHandle,
  releaseBrowser: () => {},
  loadSession: async () => session,
  saveSession: async () => {},
  invalidateSession: async () => {},
})

const post = (body: unknown) =>
  scrapeRoute(blockedDeps, () => ({})).handle(
    new Request("http://localhost/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )

const blockedRequest = { url: "https://example.com", skipHttp: true, maxTier: 2, maxTimeout: 4_000 }

describe("POST /scrape document contract", () => {
  const pdf = Buffer.from([37, 80, 68, 70, 45, 255, 0, 128])
  const result: ScrapeResult = {
    url: "https://1.1.1.1/article",
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
  const send = async (input: Record<string, unknown>, output = result) => {
    const dependencies = blockedDeps()
    const store = new MetricsStore()
    let called = false
    const app = scrapeRoute(
      () => dependencies,
      () => ({}),
      store,
      async (_request, deps) => {
        called = true
        await deps.validateOutboundUrl?.(output.url)
        return output
      },
    )
    try {
      const response = await app.handle(
        new Request("http://localhost/scrape", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: result.url, ...input }),
        }),
      )
      expect(dependencies.validateOutboundUrl).toBeUndefined()
      return { status: response.status, data: await response.json(), called }
    } finally {
      store.close()
    }
  }
  test("returns a lossless base64 document only on request", async () => {
    const response = await send({ includeResponseBody: true, maxTier: 3 })
    expect(response.status).toBe(200)
    expect(Buffer.from(response.data.document.data, "base64")).toEqual(pdf)
    expect(response.data.body).toBeUndefined()
    const normal = await send({})
    expect(normal.data.body).toBeUndefined()
    expect(normal.data.document).toBeUndefined()
  })
  test("rejects invalid mode flags and private or nonstandard targets before scraping", async () => {
    for (const input of [
      { includeResponseBody: "yes" },
      { includeResponseBody: true, url: "http://127.0.0.1/private" },
      { includeResponseBody: true, url: "https://1.1.1.1:8443/article" },
    ]) {
      const response = await send(input)
      expect(response.status).toBe(400)
      expect(response.called).toBe(false)
    }
  })
  test("validates effective destinations and reports missing captures", async () => {
    expect((await send({ includeResponseBody: true }, { ...result, url: "http://127.0.0.1/private" })).status).toBe(400)
    const missing = await send({ includeResponseBody: true }, { ...result, body: undefined })
    expect(missing.status).toBe(502)
    expect(missing.data.code).toBe("document_unavailable")
  })
  test("maps document size failures to a terminal structured response", async () => {
    const store = new MetricsStore()
    const app = scrapeRoute(
      blockedDeps,
      () => ({}),
      store,
      async () => {
        throw new DocumentError("source_too_large", "Source exceeds retrieval limit")
      },
    )
    const response = await app.handle(
      new Request("http://localhost/scrape", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: result.url, includeResponseBody: true }),
      }),
    )
    expect(response.status).toBe(413)
    expect((await response.json()).code).toBe("source_too_large")
    store.close()
  })
})

describe("POST /scrape on a blocked outcome", () => {
  test("records requests rejected before the scraper starts", async () => {
    const store = new MetricsStore()
    const app = scrapeRoute(blockedDeps, () => null, store)
    const send = (body: unknown) =>
      app.handle(
        new Request("http://localhost/scrape", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    expect((await send({ url: "https://target.example" })).status).toBe(503)
    expect((await send({ url: "" })).status).toBe(400)
    const snapshot = store.snapshot()
    expect(snapshot.requests).toBe(2)
    expect(snapshot.failures).toBe(2)
    expect(snapshot.recentEvents[0]?.domain).toBe("unknown")
    expect(snapshot.recentEvents[1]?.domain).toBe("target.example")
    store.close()
  })
  test("still answers 500 with the per-tier attempt history", async () => {
    const response = await post(blockedRequest)

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.error).toContain("Max tier reached without success")
    expect(body.timings).toEqual([{ tier: 2, status: "blocked", durationMs: expect.any(Number), reason: "http-403" }])
    expect(body.blockedEvidence).toBeUndefined()
  })

  test("carries the challenge wall when the request asked for it", async () => {
    const response = await post({ ...blockedRequest, blockedEvidence: true, screenshot: true })

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.timings[0].reason).toBe("http-403")
    expect(body.blockedEvidence).toMatchObject({
      tier: 2,
      status: "blocked",
      reason: "http-403",
      url: "https://example.com/blocked",
      statusCode: 403,
      screenshot: JPEG_BASE64,
    })
    expect(body.blockedEvidence.html).toContain("Access denied")
  })

  test("omits the image when only the markup was asked for", async () => {
    const response = await post({ ...blockedRequest, blockedEvidence: true })

    const body = await response.json()
    expect(body.blockedEvidence.html).toContain("Access denied")
    expect(body.blockedEvidence.screenshot).toBeUndefined()
  })
})
