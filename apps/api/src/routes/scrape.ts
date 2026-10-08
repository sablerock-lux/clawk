import { PoolExhaustedError } from "@trawl/browser"
import type { OrchestratorDeps } from "@trawl/tiers"
import {
  DocumentError,
  documentResponse,
  RequestValidationError,
  ScrapeError,
  sanitizeHeaders,
  scrape,
} from "@trawl/tiers"
import type { ScrapeRequest } from "@trawl/types"
import { Elysia } from "elysia"
import { flareSolverrError } from "../adapters/flaresolverr"
import { getDeps, getPool } from "../deps"
import { type MetricsStore, metrics } from "../metrics"
import { createPublicUrlValidator } from "../outbound-policy"
import { runLoggedScrape } from "../requestLogging"
import { requestUrl, validateScrapeRequest } from "../validation"

// Native TRAWL API — richer response (tier, timings, sessionCached).
// Error mapping:
//   503 — pool still initializing (native { error })
//   429 — pool exhausted (FlareSolverr envelope; uniform with /v1)
//   500 — other scrape exception (native { error, timings, blockedEvidence })
export function scrapeRoute(
  deps: () => OrchestratorDeps = getDeps,
  poolReady: () => unknown = getPool,
  metricsStore: MetricsStore = metrics,
  runScrape: typeof scrape = scrape,
) {
  return new Elysia().post("/scrape", async ({ body, set }) => {
    const started = Date.now()
    let scraperStarted = false
    try {
      validateScrapeRequest(body)
      const req: ScrapeRequest = body
      if (!poolReady()) {
        set.status = 503
        metricsStore.record({ source: "native", url: req.url, durationMs: Date.now() - started, statusCode: 503 })
        return { error: "Browser pool initializing, retry in a few seconds" }
      }
      const sanitized = { ...req, headers: sanitizeHeaders(req.headers) }
      const orchestratorDeps = { ...deps() }
      if (req.includeResponseBody) {
        const validate = createPublicUrlValidator()
        const existing = orchestratorDeps.validateOutboundUrl
        orchestratorDeps.validateOutboundUrl = async (url) => {
          const parsed = await validate(url)
          if (parsed.port && !["80", "443"].includes(parsed.port)) {
            throw new RequestValidationError("Source uses a nonstandard port", 400)
          }
          await existing?.(url)
        }
        await orchestratorDeps.validateOutboundUrl(req.url)
      }
      scraperStarted = true
      const result = await runLoggedScrape("native", sanitized, orchestratorDeps, runScrape, undefined, metricsStore)
      if (req.includeResponseBody) {
        await orchestratorDeps.validateOutboundUrl?.(result.url)
        return documentResponse(result)
      }
      const { body: _body, ...response } = result
      return response
    } catch (err) {
      if (err instanceof DocumentError) {
        set.status = err.code === "source_too_large" ? 413 : err.code === "invalid_document" ? 422 : 502
        return { error: err.message, code: err.code }
      }
      if (err instanceof RequestValidationError) {
        set.status = err.statusCode
        if (!scraperStarted)
          metricsStore.record({
            source: "native",
            url: requestUrl(body),
            durationMs: Date.now() - started,
            statusCode: err.statusCode,
            error: err,
          })
        return { error: err.message, code: "invalid_target" }
      }
      if (err instanceof PoolExhaustedError) {
        set.status = 429
        if (!scraperStarted)
          metricsStore.record({
            source: "native",
            url: requestUrl(body),
            durationMs: Date.now() - started,
            statusCode: 429,
            error: err,
          })
        return flareSolverrError(requestUrl(body), "Browser pool saturated, retry shortly")
      }
      set.status = 500
      if (!scraperStarted)
        metricsStore.record({
          source: "native",
          url: requestUrl(body),
          durationMs: Date.now() - started,
          statusCode: 500,
          error: err,
        })
      if (err instanceof ScrapeError) {
        return {
          error: err.message,
          code:
            err.timings.some((attempt) => attempt.status === "blocked" || attempt.status === "needs-js") &&
            !err.timings.some((attempt) => attempt.status === "error" || attempt.status === "timeout")
              ? "scrape_exhausted"
              : "scrape_failed",
          timings: err.timings,
          ...(err.blockedEvidence ? { blockedEvidence: err.blockedEvidence } : {}),
        }
      }
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}
