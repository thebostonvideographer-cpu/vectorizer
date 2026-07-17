# Trace — Background Remover

Free, private **background removal** in the browser.  
Upload a photo → get a **transparent PNG**.

This is what most clients actually need (cutouts for web, ads, Canva, etc.) — not a full vector rebuild.

## Why this approach

| Goal | Tool |
| --- | --- |
| Transparent PNG / no background | **This app** (free, in-browser) |
| True editable SVG vector | Vectorizer.AI / Illustrator (paid or manual) |

AI background removal runs on-device via [`@imgly/background-removal`](https://github.com/imgly/background-removal-js). Nothing is uploaded to your server.

## Local

```bash
npm run build
npm run dev
```

Open [http://localhost:8080](http://localhost:8080).

## Cloudflare deploy

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Output directory | `dist` |

Or push to GitHub — Cloudflare Pages/Workers with assets will pick it up.

Live Worker URL (after deploy): your `*.workers.dev` domain.

## Notes

- First run downloads a model (~few MB); later runs are faster (browser cache)
- Best on people, products, logos on plain/busy backgrounds
- Hair/fine edges are usually good; tough cases may need a touch-up in Photoshop
