import { fileURLToPath } from "node:url"

export const TIER1_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0"
export const TLS_PROFILE = "firefox_148"
const defaultBinary = fileURLToPath(new URL("../../../../tools/tls-fetch/bin/tls-fetch", import.meta.url))
const MAX_METADATA_BYTES = 256 * 1024

export function verifyTlsHelper(): void {
  try {
    const result = Bun.spawnSync([process.env.TLS_FETCH_BINARY ?? defaultBinary, "--version"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5000,
    })
    if (!result.success) throw new Error("helper did not start")
    const metadata = JSON.parse(result.stdout.toString())
    if (metadata.version !== 1 || metadata.profile !== TLS_PROFILE || metadata.userAgent !== TIER1_USER_AGENT) {
      throw new Error("incompatible helper profile or protocol")
    }
  } catch {
    throw new Error(
      "TLS helper missing or incompatible; run bun run build:tls or set TLS_FETCH_BINARY to the matching binary",
    )
  }
}

type TransportOptions = RequestInit & {
  timeoutMs?: number
  proxy?: string
  decompress?: boolean
  tls?: { ca?: string | string[]; rejectUnauthorized?: boolean }
}

export async function tlsFetch(url: string, init: TransportOptions = {}): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? 60_000
  if (timeoutMs <= 0) throw new Error("TLS helper request timed out")
  if (init.body != null && typeof init.body !== "string")
    throw new Error("TLS transport requires a string request body")
  const headers =
    init.headers instanceof Headers
      ? [...init.headers.entries()]
      : Array.isArray(init.headers)
        ? init.headers
        : Object.entries(init.headers ?? {})
  const ca = init.tls?.ca
  const child = Bun.spawn([process.env.TLS_FETCH_BINARY ?? defaultBinary], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  const reader = child.stdout.getReader()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  const abort = () => child.kill()
  init.signal?.addEventListener("abort", abort, { once: true })
  const cleanup = async () => {
    clearTimeout(timer)
    init.signal?.removeEventListener("abort", abort)
    child.kill()
    await reader.cancel().catch(() => {})
    await child.exited
  }
  try {
    if (init.signal?.aborted) throw new Error("TLS helper request aborted")
    child.stdin.write(
      JSON.stringify({
        version: 1,
        url,
        method: init.method ?? "GET",
        headers,
        body: typeof init.body === "string" ? Buffer.from(init.body).toString("base64") : undefined,
        proxy: init.proxy,
        ca: ca ? (Array.isArray(ca) ? ca.map(String).join("\n") : String(ca)) : undefined,
        insecure: init.tls?.rejectUnauthorized === false,
        timeoutMs,
      }),
    )
    await child.stdin.end()
    let pending = Buffer.alloc(0)
    let newline = -1
    while (newline < 0) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(timedOut ? "TLS helper request timed out" : "TLS helper closed before headers")
      pending = Buffer.concat([pending, chunk.value])
      newline = pending.indexOf(10)
      if ((newline < 0 ? pending.length : newline) > MAX_METADATA_BYTES) {
        throw new Error("TLS helper metadata exceeds limit")
      }
    }
    const metadata = JSON.parse(pending.subarray(0, newline).toString("utf8"))
    if (metadata.version !== 1) throw new Error("Unsupported TLS helper protocol")
    if (metadata.error) throw Object.assign(new Error(String(metadata.error)), { code: metadata.code })
    if (!Number.isInteger(metadata.status) || metadata.status < 200 || metadata.status > 599) {
      throw new Error("Invalid TLS helper response status")
    }
    if (!metadata.headers || typeof metadata.headers !== "object" || Array.isArray(metadata.headers)) {
      throw new Error("Invalid TLS helper response headers")
    }
    const responseHeaders = new Headers()
    for (const [name, values] of Object.entries(metadata.headers)) {
      if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
        throw new Error("Invalid TLS helper response header values")
      }
      for (const value of values) responseHeaders.append(name, value)
    }
    let prefix: Uint8Array | undefined = pending.subarray(newline + 1)
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (prefix?.length) {
            controller.enqueue(prefix)
            prefix = undefined
            return
          }
          const chunk = await reader.read()
          if (chunk.done) {
            const exitCode = await child.exited
            if (exitCode !== 0 || timedOut) throw new Error("TLS helper response interrupted or timed out")
            await cleanup()
            controller.close()
          } else {
            controller.enqueue(chunk.value)
          }
        } catch (error) {
          await cleanup()
          controller.error(error)
        }
      },
      cancel: cleanup,
    })
    const noBody = init.method === "HEAD" || [204, 205, 304].includes(metadata.status)
    if (noBody) await stream.cancel()
    const response = new Response(noBody ? null : stream, { status: metadata.status, headers: responseHeaders })
    Object.defineProperty(response, "url", { value: url })
    return response
  } catch (error) {
    await cleanup()
    throw error
  }
}

export const tier1Transport = { fetch: tlsFetch }
