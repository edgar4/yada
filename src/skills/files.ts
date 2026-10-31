import { lstat, readdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join, extname } from "node:path";

const textExtensions = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".py",
  ".sh",
  ".js",
  ".mjs",
  ".ts",
  ".html",
  ".css",
  ".svg",
]);

export async function skillDirectories(root: string): Promise<string[]> {
  const found: string[] = [];
  let count = 0;
  async function visit(path: string, depth: number) {
    if (depth > 8 || ++count > 256)
      throw new Error("Skill discovery limit exceeded");
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (
        depth === 0 &&
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Skills directory must be a real directory: ${path}`);
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.length > 256)
      throw new Error("Too many skill directory entries");
    if (entries.some((entry) => entry.isSymbolicLink()))
      throw new Error("Skill symlinks are not supported");
    if (entries.some((entry) => entry.name === "SKILL.md" && entry.isFile())) {
      found.push(path);
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1)))
      if (entry.isDirectory() && !entry.name.startsWith("."))
        await visit(join(path, entry.name), depth + 1);
  }
  await visit(root, 0);
  return found;
}

export async function skillFiles(root: string) {
  const files = new Map<string, string>();
  let bytes = 0;
  let count = 0;
  async function visit(relative: string, depth: number) {
    if (depth > 8)
      throw new Error("Skill directory nesting exceeds eight levels");
    const entries = await readdir(join(root, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (++count > 256) throw new Error("Too many skill files");
      if (entry.isSymbolicLink())
        throw new Error("Skill symlinks are not supported");
      if (entry.name.startsWith(".")) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !textExtensions.has(extname(entry.name))) continue;
      const handle = await open(
        join(root, path),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 65_536)
          throw new Error(`Skill text file exceeds 64 KiB: ${path}`);
        const buffer = Buffer.alloc(65_537);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(
            buffer,
            size,
            buffer.length - size,
            size,
          );
          if (!bytesRead) break;
          size += bytesRead;
        }
        bytes += size;
        if (size > 65_536 || bytes > 2_097_152)
          throw new Error("Skill text size limit exceeded");
        files.set(
          path,
          new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, size),
          ),
        );
      } finally {
        await handle.close();
      }
    }
  }
  await visit("", 0);
  return files;
}
