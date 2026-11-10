import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

// 網站版（Cloudflare Pages）專用：建置時設定 SITE_URL 才會啟用。
// 沒設定時（CrazyGames 的 zip、GitHub Pages）完全不改動輸出。
//   - index.html 注入 SEO / 社群卡片（Open Graph、X）/ JSON-LD
//   - #app 預先放入載入畫面與遊戲介紹文字：不跑 JS 的爬蟲（社群卡片、AI 爬蟲）也讀得到，Vue 掛載後會被取代
//   - 拿掉 CrazyGames SDK（在其他網域本來就不會啟用，省一個第三方請求）
//   - 輸出 robots.txt、sitemap.xml、llms.txt 與 site/public/ 底下的檔案（卡片圖）

const dir = import.meta.dirname

export const SITE = {
  name: 'Elf & Goblins',
  title: 'Elf & Goblins — Free 3D Hide & Seek Browser Game',
  description:
    'Play Elf & Goblins free in your browser: an asymmetric 3D hide-and-seek game. Hunt 8 goblins as a harp-playing elf, or survive 10 minutes as a goblin with your friends. Solo vs AI or online multiplayer, no download.',
  image: 'og-image.jpg',
  imageAlt: 'Elf & Goblins — a harp elf, an amethyst violinist elf and a cheeky goblin on fantasy cards. 1 Elf vs 8 Goblins.',
  themeColor: '#0b1411',
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// 結尾一律加上 /，og:url、canonical 和 sitemap 才會一致
export function normalizeSiteUrl(raw: string) {
  const u = new URL(raw)
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`SITE_URL 必須是 http(s) 網址：${raw}`)
  u.search = ''
  u.hash = ''
  return u.href.replace(/\/?$/, '/')
}

export function headTags(url: string) {
  const image = url + SITE.image
  const meta = (attr: 'name' | 'property', key: string, content: string) => `<meta ${attr}="${key}" content="${esc(content)}" />`
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'VideoGame',
    name: SITE.name,
    url,
    image,
    description: SITE.description,
    genre: ['Hide and seek', 'Asymmetric multiplayer', 'Casual', 'Action'],
    gamePlatform: ['Web browser', 'PC', 'Mobile'],
    applicationCategory: 'Game',
    operatingSystem: 'Any (WebGL 2 browser)',
    playMode: ['SinglePlayer', 'MultiPlayer'],
    numberOfPlayers: { '@type': 'QuantitativeValue', minValue: 1, maxValue: 9 },
    inLanguage: ['en', 'zh-Hant'],
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: 0, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
  }
  return [
    `<meta name="description" content="${esc(SITE.description)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta name="theme-color" content="${SITE.themeColor}" />`,
    `<link rel="apple-touch-icon" href="apple-touch-icon.png" />`,
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', SITE.name),
    meta('property', 'og:title', SITE.title),
    meta('property', 'og:description', SITE.description),
    meta('property', 'og:url', url),
    meta('property', 'og:image', image),
    meta('property', 'og:image:width', '1200'),
    meta('property', 'og:image:height', '630'),
    meta('property', 'og:image:type', 'image/jpeg'),
    meta('property', 'og:image:alt', SITE.imageAlt),
    meta('property', 'og:locale', 'en_US'),
    meta('property', 'og:locale:alternate', 'zh_TW'),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', SITE.title),
    meta('name', 'twitter:description', SITE.description),
    meta('name', 'twitter:image', image),
    meta('name', 'twitter:image:alt', SITE.imageAlt),
    `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`,
  ].join('\n    ')
}

export function transformHtml(html: string, url: string) {
  const content = readFileSync(resolve(dir, 'content.html'), 'utf8').trim()
  const out = html
    // CrazyGames SDK 與它上方的註解
    .replace(/[ \t]*<!--[^>]*CrazyGames SDK[\s\S]*?-->\s*/, '')
    .replace(/[ \t]*<script src="https:\/\/sdk\.crazygames\.com\/[^"]*"><\/script>\s*/, '')
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(SITE.title)}</title>`)
    .replace('</head>', `    ${headTags(url)}\n  </head>`)
    .replace('<div id="app"></div>', `<div id="app">\n${content}\n    </div>`)
  if (!out.includes('og:image') || !out.includes('id="seo"')) throw new Error('site plugin：index.html 結構改變，注入失敗')
  return out
}

export function robots(url: string) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${url}sitemap.xml\n`
}

export function sitemap(url: string, lastmod = new Date().toISOString().slice(0, 10)) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${esc(url)}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>
</urlset>
`
}

export function sitePlugin(rawUrl: string | undefined): Plugin | null {
  if (!rawUrl) return null
  const url = normalizeSiteUrl(rawUrl)
  let outDir = 'dist'
  return {
    name: 'elf-goblins-site',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir)
    },
    transformIndexHtml: {
      order: 'pre',
      handler: (html, ctx) => (ctx.filename.endsWith('index.html') ? transformHtml(html, url) : html),
    },
    closeBundle() {
      if (!existsSync(outDir)) return
      cpSync(resolve(dir, 'public'), outDir, { recursive: true })
      writeFileSync(resolve(outDir, 'robots.txt'), robots(url))
      writeFileSync(resolve(outDir, 'sitemap.xml'), sitemap(url))
      writeFileSync(resolve(outDir, 'llms.txt'), readFileSync(resolve(dir, 'llms.txt'), 'utf8').replaceAll('{{SITE_URL}}', url))
    },
  }
}
