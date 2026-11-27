const files: Record<string, string> =
  process.env.NODE_ENV === "production" ? (await import("./client-files.gen")).default : {};

const immutable = { "cache-control": "public, max-age=31536000, immutable" };

export const pages: Record<string, Response> = {};

for (const [path, file] of Object.entries(files)) {
  pages[path] = new Response(
    Bun.file(file),
    path.startsWith("/assets/") ? { headers: immutable } : {},
  );
}

if (files["/index.html"]) pages["/*"] = new Response(Bun.file(files["/index.html"]));
