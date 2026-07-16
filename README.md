# Trace — Image to Vector

Browser-based JPEG/PNG → SVG vectorizer powered by [VTracer](https://github.com/visioncortex/vtracer) (WebAssembly).  
Nothing is uploaded to a server — conversion runs entirely in the visitor’s browser.

**Production target:** `https://vectorizer.thebostonvideographer.com`

---

## Path audit (subdomain-safe)

All local assets use **relative** paths so the app works on a subdomain or any base URL:

| Asset | Reference |
| --- | --- |
| CSS | `./styles.css` |
| App JS | `./app.js` |
| VTracer JS | `./vendor/vtracer/vtracer.js` |
| VTracer WASM | `new URL("./vendor/vtracer/vtracer.wasm", import.meta.url)` |
| Brand home | `./` |

External only: Google Fonts CDN (`fonts.googleapis.com` / `fonts.gstatic.com`).  
No hardcoded `localhost`, absolute site paths, or machine-local paths.

---

## Local development

```bash
npm run build
npm run dev
```

Or without Node serving:

```bash
npm run build
python3 -m http.server 8080 --directory dist
```

Open [http://localhost:8080](http://localhost:8080).

> Must be served over HTTP(S). Opening `index.html` as `file://` will fail (ES modules + WASM).

---

## Cloudflare Pages build settings

| Setting | Value |
| --- | --- |
| **Framework preset** | None |
| **Build command** | `npm run build` |
| **Build output directory** | `dist` |
| **Root directory** | `/` (repo root) |
| **Node version** | 18 or newer (optional env `NODE_VERSION=18`) |

`npm run build` copies the static site into `dist/` and writes a `_headers` file so `.wasm` is served as `application/wasm`.

---

## Deploy guide

### a) Push to a new GitHub repo

From this project folder:

```bash
# If git is not initialized yet:
git init
git add index.html styles.css app.js package.json README.md scripts vendor .gitignore
git commit -m "Add Trace vectorizer for Cloudflare Pages"

# Create an empty repo on GitHub (example name: trace-vectorizer), then:
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/trace-vectorizer.git
git push -u origin main
```

Or use GitHub’s site: **New repository** → then upload / push this folder.

Do **not** commit secrets. This project has none. You can skip `vectorizer-deploy.zip` and `dist/` (already in `.gitignore`).

---

### b) Connect the repo to Cloudflare Pages

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Go to **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
3. Authorize GitHub and select your `trace-vectorizer` repo
4. Configure:
   - **Project name:** `trace-vectorizer` (or similar — this becomes `*.pages.dev`)
   - **Production branch:** `main`
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
5. Click **Save and Deploy**
6. Wait for the first deploy. You’ll get a URL like:  
   `https://trace-vectorizer.pages.dev`

Confirm that URL loads and tracing works before adding the custom domain.

---

### c) Point `vectorizer.thebostonvideographer.com` at the project

#### In Cloudflare Pages

1. Open your Pages project → **Custom domains** → **Set up a domain**
2. Enter: `vectorizer.thebostonvideographer.com`
3. Cloudflare will tell you the DNS record to add

#### DNS record

**If `thebostonvideographer.com` DNS is already on Cloudflare:**

1. Go to **Websites** → `thebostonvideographer.com` → **DNS** → **Records**
2. Add:

| Type | Name | Target | Proxy |
| --- | --- | --- | --- |
| `CNAME` | `vectorizer` | `trace-vectorizer.pages.dev` | Proxied (orange cloud) **or** DNS only |

Use the exact `*.pages.dev` hostname shown in your Pages project (project name may differ).

**If DNS is still at Namecheap (or another registrar):**

1. Namecheap → **Domain List** → `thebostonvideographer.com` → **Advanced DNS**
2. Add:

| Type | Host | Value |
| --- | --- | --- |
| `CNAME Record` | `vectorizer` | `trace-vectorizer.pages.dev.` |

(Include the trailing dot if Namecheap shows it; otherwise omit.)

3. Remove any conflicting `A` / `CNAME` for `vectorizer` if one already exists
4. Wait for DNS (often a few minutes; up to 24h)

#### Finish in Pages

Back in **Pages → Custom domains**, wait until the domain status is **Active**.  
Then open:

`https://vectorizer.thebostonvideographer.com`

---

## WordPress header link

In WordPress: **Appearance → Menus** (or your header builder) → add a custom link:

- **URL:** `https://vectorizer.thebostonvideographer.com`
- **Label:** `Vectorizer` (or similar)

---

## Quality tips

- **Exact match** → closest visual fidelity (larger SVG, slower)
- **Logo (smooth)** → cleaner, smaller SVGs for brand marks
- Soft photos will look posterized; vectorizers approximate shapes
