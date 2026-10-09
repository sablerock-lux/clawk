import { createHash } from "node:crypto"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { basename, join } from "node:path"

const revision = "b93e0ff525d90fe665bb838c4781443b6166ab79"
const repository = "StopMakingThatBigFace/node-wreq"
const root = join(import.meta.dir, "..")
const scratch = await mkdtemp(join(tmpdir(), "clawk-native-notices-"))
const targets = ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]

async function linuxPackages(): Promise<Set<string>> {
  const { uid, gid } = userInfo()
  await Bun.write(join(scratch, "native/Cargo.toml"), await source("rust/Cargo.toml"))
  await Bun.write(join(scratch, "native/Cargo.lock"), await source("rust/Cargo.lock"))
  await Bun.write(join(scratch, "native/src/lib.rs"), await source("rust/src/lib.rs"))
  const included = new Set<string>()
  for (const target of targets) {
    const process = Bun.spawn(
      [
        "docker",
        "run",
        "--rm",
        "--user",
        `${uid}:${gid}`,
        "--volume",
        `${scratch}:/audit`,
        "--env",
        "CARGO_HOME=/audit/cargo-home",
        "rust:1.98.0",
        "cargo",
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--manifest-path",
        "/audit/native/Cargo.toml",
        "--filter-platform",
        target,
      ],
      { stdout: "pipe", stderr: "inherit" },
    )
    const output = await new Response(process.stdout).text()
    if ((await process.exited) !== 0) throw new Error(`Cannot resolve ${target}`)
    const metadata = JSON.parse(output) as {
      packages: { id: string; name: string; version: string; source: string | null }[]
      resolve: { root: string; nodes: { id: string; dependencies: string[] }[] }
    }
    const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
    const reachable = new Set<string>()
    const pending = [metadata.resolve.root]
    while (pending.length) {
      const identifier = pending.pop()
      if (identifier === undefined) throw new Error("Missing dependency identifier")
      if (reachable.has(identifier)) continue
      reachable.add(identifier)
      const node = nodes.get(identifier)
      if (!node) throw new Error(`Missing dependency node: ${identifier}`)
      pending.push(...node.dependencies)
    }
    for (const dependency of metadata.packages) {
      if (dependency.source && reachable.has(dependency.id)) included.add(`${dependency.name}@${dependency.version}`)
    }
    console.log(`Resolved ${target}: ${reachable.size - 1} dependencies`)
  }
  return included
}

async function github(endpoint: string) {
  const process = Bun.spawn(["gh", "api", endpoint], {
    env: { ...Bun.env, GH_PAGER: "cat", PAGER: "cat", TERM: "dumb" },
    stdout: "pipe",
    stderr: "inherit",
  })
  const result = await new Response(process.stdout).json()
  if ((await process.exited) !== 0) throw new Error(`Cannot read upstream ${endpoint}`)
  return result
}

async function source(filename: string, owner = repository, commit = revision): Promise<string> {
  const result = await github(`repos/${owner}/contents/${filename}?ref=${commit}`)
  return Buffer.from(result.content, "base64").toString("utf8")
}

async function licenseFiles(directory: string, licenseDirectory = false): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name)
    if (entry.isDirectory())
      files.push(...(await licenseFiles(filename, licenseDirectory || /^licen[cs]es?$/i.test(entry.name))))
    else if (licenseDirectory || /^(licen[cs]es?|copying|copyright|notice|authors)([._-]|$)/i.test(basename(filename)))
      files.push(filename)
  }
  return files.sort()
}

try {
  const [license, lockfile] = await Promise.all([source("LICENSE"), source("rust/Cargo.lock")])
  const included = await linuxPackages()
  const packages = (
    Bun.TOML.parse(lockfile) as {
      package: { name: string; version: string; source?: string; checksum?: string }[]
    }
  ).package.filter((dependency) => included.has(`${dependency.name}@${dependency.version}`))
  if (packages.length !== included.size) throw new Error("Resolved dependencies differ from pinned lockfile")
  const sections = await Promise.all(
    Array.from({ length: 6 }, async (_, worker) => {
      const results: { name: string; text: string }[] = []
      for (let index = worker; index < packages.length; index += 6) {
        const dependency = packages[index]
        if (!dependency) throw new Error("Missing locked dependency")
        if (!dependency.source) continue
        if (dependency.source !== "registry+https://github.com/rust-lang/crates.io-index")
          throw new Error(`Unrecognized source: ${dependency.source}`)
        const name = `${dependency.name}-${dependency.version}`
        const url = `https://static.crates.io/crates/${dependency.name}/${name}.crate`
        const response = await fetch(url)
        if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
        const archive = new Uint8Array(await response.arrayBuffer())
        const checksum = createHash("sha256").update(archive).digest("hex")
        if (checksum !== dependency.checksum) throw new Error(`${name}: checksum mismatch`)
        const archiveFile = join(scratch, `${name}.crate`)
        await Bun.write(archiveFile, archive)
        const extraction = Bun.spawn(["tar", "-xzf", archiveFile, "-C", scratch], {
          stdout: "ignore",
          stderr: "inherit",
        })
        if ((await extraction.exited) !== 0) throw new Error(`${name}: extraction failed`)
        const directory = join(scratch, name)
        const manifest = Bun.TOML.parse(await Bun.file(join(directory, "Cargo.toml")).text()) as {
          package: { license?: string; "license-file"?: string; repository?: string }
        }
        const files = await licenseFiles(directory)
        const declared = manifest.package["license-file"]
        if (declared && !files.includes(join(directory, declared))) files.push(join(directory, declared))
        const texts = await Promise.all(
          files.map(async (filename) => `${filename.slice(directory.length + 1)}\n${await Bun.file(filename).text()}`),
        )
        if (!texts.length) {
          const owner = manifest.package.repository?.match(/github\.com[/:]([^/]+\/[^/#]+)/)?.[1]?.replace(/\.git$/, "")
          const vcs = await Bun.file(join(directory, ".cargo_vcs_info.json")).json()
          if (!owner || !vcs.git?.sha1) throw new Error(`${name}: missing pinned license source`)
          const upstream = (await github(`repos/${owner}/contents?ref=${vcs.git.sha1}`)) as {
            name: string
            path: string
            type: string
          }[]
          for (const entry of upstream) {
            if (entry.type === "file" && /^(licen[cs]es?|copying|copyright|notice|authors)([._-]|$)/i.test(entry.name))
              texts.push(
                `https://github.com/${owner}/blob/${vcs.git.sha1}/${entry.path}\n${await source(entry.path, owner, vcs.git.sha1)}`,
              )
          }
          if (!texts.length) throw new Error(`${name}: no license text supplied by pinned source`)
        }
        results.push({
          name,
          text: [
            name,
            `Declared license: ${manifest.package.license ?? declared ?? "unspecified"}`,
            `Source: ${url}`,
            `SHA256: ${checksum}`,
            ...texts,
          ].join("\n\n"),
        })
        console.log(`Collected ${name}`)
        await rm(directory, { recursive: true })
        await rm(archiveFile)
      }
      return results
    }),
  )
  const inventory = sections.flat().sort((left, right) => left.name.localeCompare(right.name))
  const text = [
    "Clawk Tier 1 native transport notices",
    `node-wreq 3.2.1: https://github.com/${repository}/tree/${revision}`,
    "Generated by tools/native-notices.ts from the pinned source Cargo.lock.",
    `Scope: ${targets.join(", ")}. Includes reachable runtime and build dependencies.`,
    "Resolved with Rust 1.98.0 cargo metadata --locked --filter-platform; no cross-architecture execution.",
    "The npm native binaries are integrity-pinned in bun.lock, not rebuilt by Clawk.",
    "This source inventory is not a reproducible-build attestation for those binaries.",
    license,
    ...inventory.map((entry) => `\n${"=".repeat(72)}\n\n${entry.text}`),
  ].join("\n\n")
  await Bun.write(
    join(root, "THIRD_PARTY_NOTICES.txt"),
    `${text
      .replace(/\r\n?/g, "\n")
      .replace(/[\t ]+$/gm, "")
      .trimEnd()}\n`,
  )
  console.log(`Wrote notices for node-wreq and ${inventory.length} locked crates`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
