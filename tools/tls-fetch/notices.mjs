import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(fileURLToPath(import.meta.url))
const vendor = join(root, "vendor")
const files = []
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name)
    if (entry.isDirectory()) visit(filename)
    else if (/^(LICENSE|COPYING|NOTICE|COPYRIGHT)/i.test(entry.name)) files.push(filename)
  }
}
visit(vendor)
const header =
  "Clawk TLS helper third-party notices\n\nThis helper includes tls-client developed by Bogdan Finn and the dependencies listed below.\nUpstream license texts are reproduced verbatim, including their acknowledgment requirements.\n\n"
const notices = files
  .sort()
  .map((filename) => `${relative(vendor, filename)}\n${"=".repeat(72)}\n${readFileSync(filename, "utf8")}\n`)
writeFileSync(join(root, "THIRD_PARTY_NOTICES.txt"), header + notices.join("\n"))
