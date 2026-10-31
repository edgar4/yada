---
layout: doc
title: "Packaging and deployment"
description: "Package and deploy Yada using installable ESM tarballs, a local Docker example and GitHub Pages documentation. Review host security and recovery requirements."
---

# Packaging and deployment

Yada requires Node 24 and uses ESM. Install the public MIT-licensed package from npm:

```sh
npm install @edgaralochi/yada
```

Versioned tarballs are also installable without a registry:

```sh
npm ci
npx playwright install chromium
npm run check
npm run test:package
npm pack
npm install /absolute/path/edgaralochi-yada-0.2.0.tgz
```

Import the runtime from `@edgaralochi/yada`, the browser client from `@edgaralochi/yada/client`, and the widget from `@edgaralochi/yada/widget`. Browser modules are ESM intended for your application's bundler, with dependencies resolved from the installed package. All three exports include TypeScript declarations. The archive includes compiled code, documentation, the README, license, package metadata and an explicit list of starter template files. The `yada init` executable generates the standalone app described in the [starter guide](starter.md). Generated configs and database files are excluded. `npm run test:package` installs the archive in a fresh directory, imports all exports, runs a deterministic provider and SQLite, and checks consumer declaration resolution.

Publish a new version with `npm publish --access public` after the release checks pass. The release workflow validates a `v<package version>` tag or a manual run and uploads the tarball and SHA-256 checksum as CI artifacts. It does not publish to a registry or create a public release. Bump `package.json` and its lockfile together before creating a version tag. Download the artifact from that workflow run and verify `sha256sum -c SHA256SUMS` before installing it.

## Local container example

The Docker image runs `deploy/server.mjs`: a single fixed demo identity, a deterministic provider, no tools, and a shared bearer token. It is a local integration example. Applications must supply their own verified session authentication, profile authorization, providers and tools before using real accounts or data.

```sh
docker build -t yada:0.2.0 .
docker volume create yada-data
export YADA_DEMO_TOKEN=$(openssl rand -hex 32)
export YADA_STORAGE_KEY=$(openssl rand -hex 32)
docker run --rm --init --name yada -p 127.0.0.1:3000:3000 \
  -e YADA_DEMO_TOKEN -e YADA_STORAGE_KEY \
  -e YADA_STORAGE_FILE=/data/yada.sqlite \
  -v yada-data:/data yada:0.2.0
```

Retain the encryption key securely across restarts. A new key cannot read existing encrypted records. The image runs as the unprivileged `node` user and handles SIGTERM by stopping HTTP admission, disconnecting active event streams, stopping its worker and closing storage. Disconnected clients can reconnect and replay persisted events after restart. Allow enough termination grace for worker shutdown.

Run `npm run test:deployment` with Docker running to build the image and verify authentication, submission, event replay, restart persistence and SIGTERM with an open stream. The smoke test creates and removes its own temporary container, image and data volume.

For your application, replace the composition module with your own `.mjs` file mounted at `/app/server.mjs`. It can import `@edgaralochi/yada` from the image. Resolve actor and tenant identity in `authenticate(request)` from a verified server session; never derive identity from message bodies. Authorize every requested profile. Keep provider credentials, storage keys, OAuth tokens and mutation approval secrets on the server. Configure exact allowed browser origins, and implement CSRF/session controls in your host or proxy.

Terminate TLS at your reverse proxy. Forward authenticated fetch/NDJSON event streams without buffering, preserve reconnect cursors, and set proxy/request timeouts for the intended run duration. Stream disconnects must not become new run submissions. Keep the worker running independently of browser connections. Do not expose a privileged worker or database endpoint publicly.

Use SQLite on persistent local storage for a single host, or configure PostgreSQL/MySQL with `YADA_STORAGE_DRIVER`, `YADA_STORAGE_URL` and `YADA_STORAGE_KEY` for shared durable storage. See [storage](storage.md) and [recovery](recovery.md). Back up the database and key separately, test restoration, and retain an image/tarball checksum for rollback. Before rolling back application code, confirm its stored schema/checkpoint compatibility and stop admission while replacing workers. Never retry an uncertain external mutation without checking its durable operation receipt.

Before a live cutover, validate application authentication, cross-tenant isolation, real provider/MCP credentials, approval expiry and revocation, receipt reconciliation, SSE replay, cancellation, restart recovery and database backup restoration in your environment. The deterministic package smoke test does not establish those live guarantees.

## Project website

The project website lives in `site/` and is published to GitHub Pages by the Pages workflow. Edit `site/index.html` for the landing page, `site/assets/` for styling and browser behavior, and Markdown files in `docs/` for technical guides. The workflow copies the guides into the site before the Jekyll build, so guides stay readable on GitHub and publish at the site root. Site links follow `url` and `baseurl` in `site/_config.yml`: use an empty `baseurl` for a custom domain or the repository path for a project site. A configured custom domain is retained in `site/CNAME`.

New guides use this front matter followed by a Markdown heading and content:

```yaml
---
layout: doc
title: "Your guide"
description: "A concise description of this guide’s specific topic."
---
```

Add guides to `site/_data/navigation.yml`. Relative Markdown links between guides become HTML links during the Pages build. The Pages workflow renders the site with GitHub’s official Jekyll action, verifies internal links and desktop/mobile accessibility, and uploads rendered pages and screenshots as the `pages-preview` artifact. On `main` it then deploys the checked build; set the repository’s Pages source to GitHub Actions.

Each published guide supplies its own title and description. The shared head emits canonical, Open Graph and Twitter Card metadata, plus structured source-code and page information. Canonical URLs, crawl files and social image links use `url` and `baseurl` together. The sitemap contains published landing and guide pages; it omits assets and crawl files. The custom-domain deployment serves `robots.txt` at the host root. A project-path deployment cannot control its domain’s root robots file.

The shared PNG social card is `site/assets/brand/yada-social.png`. Preserve its 1200 × 630 dimensions and descriptive alternative text when replacing it. Regenerate the selected-brand card with `node scripts/render-social-card.mjs` after installing Chromium. `scripts/check-seo.mjs`, invoked by the Pages checker, verifies unique metadata, canonical URLs, JSON-LD, sitemap coverage, robots directives and the PNG image. Search engines and social platforms decide how to display this information; metadata does not guarantee indexing or a particular search appearance.

Implementation references: [canonical URLs](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls), [sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap), [root robots files](https://developers.google.com/crawling/docs/robots-txt/create-robots-txt), and [SoftwareSourceCode properties](https://schema.org/SoftwareSourceCode).
