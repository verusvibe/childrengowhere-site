# ChildrenGoWhere website

Static marketing, support and privacy site for the ChildrenGoWhere iOS app. It deploys to GitHub Pages and works both as a project site (`https://<user>.github.io/<repo>/`) and on a custom domain.

Pages: landing page (problem, features, screenshots, One-Pager, North Star Metric, FAQ), `/support/`, `/privacy/`, `/terms/`, `/404.html`.

## Quick start

Requires Node 20 or later. The build, check and serve scripts have no dependencies; `sharp` is only needed to regenerate images.

```bash
npm run build     # src/ -> dist/
npm run check     # links, anchors, SEO tags, CSP-safe markup, JSON-LD, size limits
npm run serve     # http://localhost:4173 (gzip, 404 handling, like GitHub Pages)
npm test          # build + check
```

Images are generated once and committed, so CI never needs `sharp`:

```bash
npm install       # first time only (installs sharp)
npm run images    # source-images/ -> src/assets/img + src/assets/icons
```

## Layout

```
src/                  page sources, partials, CSS, JS and generated images
  index.html          landing page
  privacy/ support/   inner pages (front matter sets title, description, schema)
  404.html
  partials/           layout, header, footer, sticky CTA
  assets/             css, js, img (generated), icons (generated)
source-images/        the 8 App Store screenshots and the app icon (never published)
scripts/              build.mjs, check.mjs, serve.mjs, images.mjs
site.config.json      the only file you normally edit
.github/workflows/    pages.yml (build, check, deploy)
```

## Configuration (`site.config.json`)

| Key | Meaning |
| --- | --- |
| `appStoreUrl` | Full App Store URL. While empty, every download button shows a disabled "Coming soon" state. |
| `appStoreId` | Numeric App Store ID. Enables the Smart App Banner and is omitted while empty. |
| `customDomain` | e.g. `www.example.com`. Writes a `CNAME` file and makes URLs root-relative. Leave empty for a project site. |
| `siteUrl` | Optional fallback origin plus path, used only when CI does not supply one. |
| `contactEmail` | Shown on Support and Privacy and used in structured data. |
| `supportResponseTime` | Text shown on the Support page. Confirm this is a promise you can keep. |
| `privacyUpdated`, `privacyUpdatedLabel` | Drive the Privacy Policy "Last updated" line, sitemap `lastmod` and JSON-LD. Change them whenever the policy text changes. |
| `termsUpdated`, `termsUpdatedLabel` | The same for the Terms of Service. |

## How URLs work

Every internal URL goes through `{{BASE}}` (empty on a custom domain, `/repo-name` on a project site), and every absolute URL (canonical, Open Graph, JSON-LD, sitemap) goes through `{{SITE_URL}}`. In CI both come from `actions/configure-pages`; locally they default to `""` and `http://localhost:4173`. Override with environment variables:

```bash
# Test the project-site shape locally
SITE_URL=https://you.github.io/childrengowhere-web BASE_PATH=/childrengowhere-web \
  node scripts/build.mjs --out dist-sub
node scripts/check.mjs --dir dist-sub
node scripts/serve.mjs --dir dist-sub --port 4174 --base /childrengowhere-web
# open http://localhost:4174/childrengowhere-web/
```

CSS and JS are fingerprinted (GitHub Pages caches for about 10 minutes and the headers cannot be changed). Pages cannot set HTTP headers, so the Content-Security-Policy is a `<meta>` tag; the site uses no inline scripts or styles.

## Deploy to GitHub Pages

Nothing below has been run for you. GitHub Pages on a free plan needs a public repository.

1. Create an empty public repository on github.com (no README, no license, no .gitignore), then from this folder:

   ```bash
   git init -b main
   git add .
   git status        # confirm no node_modules, dist or .plist files are staged
   git commit -m "Add ChildrenGoWhere website"
   git remote add origin git@github.com:<your-user>/childrengowhere-web.git   # or the https URL
   git push -u origin main
   ```

   With the GitHub CLI you can instead run
   `gh repo create <your-user>/childrengowhere-web --public --source=. --remote=origin --push`.

2. In the repository go to **Settings > Pages** and set **Source** to **GitHub Actions**.
3. The workflow builds, checks and deploys on every push to `main`. The site appears at `https://<your-user>.github.io/childrengowhere-web/`. Pull requests run build and check only.

### Custom domain

1. Set `customDomain` in `site.config.json` and push. The build writes the `CNAME` file.
2. In **Settings > Pages > Custom domain** enter the domain, then add the DNS records GitHub lists in its current custom-domain documentation (apex `A`/`AAAA` records, or a `CNAME` to `<your-user>.github.io` for a subdomain).
3. Tick **Enforce HTTPS** once the certificate is issued.

## SEO and search engines

- `robots.txt` is only read by crawlers at the root of a host. On a project-site subpath it is ignored, so the site relies on per-page `robots` meta tags and canonical URLs. A custom domain restores normal `robots.txt` behaviour.
- Submit `/sitemap.xml` in Google Search Console and Bing Webmaster Tools after the first deploy.
- If the URL changes later (for example moving to a custom domain), update the config and redeploy so canonicals, Open Graph URLs, JSON-LD and the sitemap all change together.

## App Store Connect URLs

| Field | URL |
| --- | --- |
| Marketing URL | `<site url>/` |
| Support URL | `<site url>/support/` |
| Privacy Policy URL | `<site url>/privacy/` |
| Terms of Use (optional custom EULA link) | `<site url>/terms/` |

## Before you go live

- [ ] Choose the repository name and, if wanted, the custom domain.
- [ ] Fill in `appStoreUrl` and `appStoreId` when the app is approved.
- [ ] Have the Privacy Policy and Terms of Service reviewed by a lawyer, and add the legal entity name if required. The open decisions are listed in the comment at the top of `src/terms/index.html`.
- [ ] Point the iOS app's `AppLinks.termsOfService` at `<site url>/terms/` (it currently uses Apple's standard EULA).
- [ ] Confirm the support response time, and make sure the `contactEmail` mailbox (currently `hello@childrengowhere.com`, on the domain's iCloud mail) is monitored. The address is in public HTML, so expect some spam.
- [ ] Choose a `LICENSE` (none is included).
- [ ] Review copy for claims that are not yet true in the shipping build.
