import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

export async function browserModules(
  request: Request,
  html: string,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/")
    return new Response(html, { headers: { "content-type": "text/html" } });
  if (!/^\/(?:src\/[\w/-]+|node_modules\/zod\/[\w/.-]+)\.js$/.test(pathname))
    return new Response(null, { status: 404 });
  const file = resolve(
    `.${pathname.startsWith("/src/") ? pathname.replace(/\.js$/, ".ts") : pathname}`,
  );
  const source = await readFile(file, "utf8");
  return new Response(
    file.endsWith(".ts")
      ? ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
          },
        }).outputText
      : source,
    { headers: { "content-type": "application/javascript" } },
  );
}
