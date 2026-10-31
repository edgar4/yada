import { parseDocument } from "yaml";
import { z } from "zod";

const metadata = z.looseObject({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export function parseSkill(source: string, directoryName: string) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(
    source,
  );
  if (!match)
    throw new Error(`Skill ${directoryName}: expected YAML frontmatter`);
  const document = parseDocument(match[1] ?? "", { uniqueKeys: true });
  if (document.errors.length || document.warnings.length)
    throw new Error(`Skill ${directoryName}: invalid YAML metadata`);
  const parsed = metadata.safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!parsed.success || parsed.data.name !== directoryName)
    throw new Error(`Skill ${directoryName}: invalid name or metadata`);
  if (!match[2]?.trim())
    throw new Error(`Skill ${directoryName}: empty instructions`);
  const { name, description, compatibility } = parsed.data;
  const unsupported = Object.keys(parsed.data).filter(
    (key) =>
      !["name", "description", "license", "compatibility", "metadata"].includes(
        key,
      ),
  );
  return {
    name,
    description,
    ...(compatibility ? { compatibility } : {}),
    warnings: unsupported.map(
      (field) =>
        `Skill ${name}: ${field} is not enforced by Yada; host tool permissions still apply`,
    ),
  };
}
