import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib"
import type { ScrapeResponse, ScrapeResult } from "@trawl/types"

export const DOCUMENT_MAX_BYTES = 10_000_000

export class DocumentError extends Error {
  constructor(
    public readonly code: "source_too_large" | "invalid_document" | "document_unavailable",
    message: string,
  ) {
    super(message)
    this.name = "DocumentError"
  }
}

export function checkDocumentSize(size: number): void {
  if (size > DOCUMENT_MAX_BYTES) throw new DocumentError("source_too_large", "Source exceeds retrieval limit")
}

export function decodeDocument(body: Uint8Array, contentEncoding?: string): Uint8Array {
  checkDocumentSize(body.byteLength)
  let decoded: Uint8Array = body
  const options = { maxOutputLength: DOCUMENT_MAX_BYTES }
  for (const encoding of (contentEncoding ?? "").toLowerCase().split(",").reverse()) {
    try {
      switch (encoding.trim()) {
        case "":
        case "identity":
          break
        case "gzip":
        case "x-gzip":
          decoded = gunzipSync(decoded, options)
          break
        case "deflate":
          decoded = inflateSync(decoded, options)
          break
        case "br":
          decoded = brotliDecompressSync(decoded, options)
          break
        case "zstd":
          decoded = zstdDecompressSync(decoded, options)
          break
        default:
          throw new DocumentError("invalid_document", "Unsupported source content encoding")
      }
    } catch (error) {
      if (error instanceof DocumentError) throw error
      if (error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") {
        throw new DocumentError("source_too_large", "Source exceeds retrieval limit")
      }
      throw new DocumentError("invalid_document", "Invalid source content encoding")
    }
    checkDocumentSize(decoded.byteLength)
  }
  return decoded
}

export async function readDocument(response: Response): Promise<Uint8Array> {
  checkDocumentSize(Number(response.headers.get("content-length") ?? 0))
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      checkDocumentSize(size)
      chunks.push(chunk.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

export function documentResponse(
  result: ScrapeResult,
): ScrapeResponse & { document: NonNullable<ScrapeResponse["document"]> } {
  const { body, ...rest } = result
  if (body === undefined) throw new DocumentError("document_unavailable", "Source body could not be captured")
  const decoded = result.tier === 1 ? decodeDocument(body, result.responseHeaders?.["content-encoding"]) : body
  checkDocumentSize(decoded.byteLength)
  checkDocumentSize(Buffer.byteLength(result.html))
  return {
    ...rest,
    document: {
      encoding: "base64" as const,
      data: Buffer.from(decoded).toString("base64"),
      byteLength: decoded.byteLength,
      contentType: result.contentType ?? "application/octet-stream",
    },
  }
}
