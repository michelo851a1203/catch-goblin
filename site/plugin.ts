import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

// 網站版（Cloudflare Pages）專用：建置時設定 SITE_URL 才會啟用。
// 沒設定時（CrazyGames 的 zip、GitHub Pages）完全不改動輸出。
//   - index.html 注入 SEO / 社群卡片（Open Graph、X）/ JSON-LD
//   - #app 預先放入載入畫面與遊戲介紹文字：不跑 JS 的爬蟲（社群卡片、AI 爬蟲）也讀得到，Vue 掛載後會被取代
//   - 拿掉 CrazyGames SDK（在其他網域本來就不會啟用，省一個第三方請求）
//   - 輸出 robots.txt、sitemap.xml、llms.txt、manifest.webmanifest 與 site/public/ 底下的檔案（卡片圖、App 圖示）
//   - 安全標頭：Cloudflare Pages 的 _headers（CSP、nosniff、Referrer-Policy、Permissions-Policy、禁止被其他網站嵌入），
//     index.html 也放同一份 CSP 的 <meta>（vite preview 測得到；meta 不支援 frame-ancestors）

const dir = import.meta.dirname

export const SITE = {
  name: 'Run, Goblins!',
  title: 'Run, Goblins! — Free 3D Hide & Seek Browser Game',
  description:
    'Play Run, Goblins! free in your browser: an asymmetric 3D hide-and-seek game. Hunt 8 goblins as a harp-playing elf, or survive 10 minutes as a goblin with your friends. Solo vs AI or online multiplayer, no download.',
  image: 'og-image.jpg',
  imageAlt: 'Run, Goblins! — a harp elf, an amethyst violinist elf and a cheeky goblin on fantasy cards. 1 Elf vs 8 Goblins.',
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
    // 加入主畫面後以全螢幕開啟（引導步驟見 src/input/install.ts）
    `<link rel="manifest" href="manifest.webmanifest" />`,
    meta('name', 'mobile-web-app-capable', 'yes'),
    meta('name', 'apple-mobile-web-app-capable', 'yes'),
    meta('name', 'apple-mobile-web-app-status-bar-style', 'black-translucent'),
    meta('name', 'apple-mobile-web-app-title', SITE.name),
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

// ───── 安全標頭 ─────
// 連線對象由建置時的環境變數決定（與 src/net/room.ts、src/net/ice.ts 相同的變數）
export type CspEnv = { VITE_TURN_URL?: string; VITE_PEER_HOST?: string; VITE_PEER_PORT?: string }

// PeerJS 信令：預設公用伺服器 0.peerjs.com（HTTPS 取得 peer id + WSS 信令）；設定 VITE_PEER_HOST 時改用自架的 PeerServer（room.ts 一律 secure）
function peerOrigins(env: CspEnv) {
  const host = env.VITE_PEER_HOST || '0.peerjs.com'
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error(`VITE_PEER_HOST 格式錯誤：${host}`)
  const port = env.VITE_PEER_HOST ? Number(env.VITE_PEER_PORT) || 443 : 443
  const hp = port === 443 ? host : `${host}:${port}`
  return [`https://${hp}`, `wss://${hp}`]
}

function turnOrigin(env: CspEnv) {
  if (!env.VITE_TURN_URL) return []
  const u = new URL(env.VITE_TURN_URL)
  if (u.protocol !== 'https:') throw new Error(`VITE_TURN_URL 必須是 https 網址：${env.VITE_TURN_URL}`)
  return [u.origin]
}

// frameAncestors：HTTP 標頭才有效，<meta> 版本要拿掉（瀏覽器會忽略並在 console 警告）
export function contentSecurityPolicy(env: CspEnv = {}, { frameAncestors = true } = {}) {
  const d: [string, ...string[]][] = [
    ['default-src', "'self'"],
    // wasm-unsafe-eval：GLB 的 EXT_meshopt_compression 解碼器（three/addons meshopt_decoder）使用 WebAssembly
    ['script-src', "'self'", "'wasm-unsafe-eval'"],
    // Vue 的 :style 綁定、shaders 套件與 site/content.html 的行內樣式
    ['style-src', "'self'", "'unsafe-inline'"],
    // three.js 的 GLB 內嵌貼圖會轉成 blob: URL；canvas / data: 圖片
    ['img-src', "'self'", 'data:', 'blob:'],
    ['font-src', "'self'"],
    ['media-src', "'self'"],
    // blob: / data:：GLTFLoader 以 fetch 讀取內嵌貼圖（ImageBitmapLoader）與 data URI
    ['connect-src', "'self'", 'blob:', 'data:', ...peerOrigins(env), ...turnOrigin(env)],
    ['worker-src', "'self'", 'blob:'],
    ['manifest-src', "'self'"],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
  ]
  if (frameAncestors) d.push(['frame-ancestors', "'self'"])
  return d.map((x) => x.join(' ')).join('; ')
}

// Cloudflare Pages 的 _headers 格式：https://developers.cloudflare.com/pages/configuration/headers/
export function headersFile(env: CspEnv = {}) {
  return [
    '/*',
    `  Content-Security-Policy: ${contentSecurityPolicy(env)}`,
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    // 只關掉遊戲用不到的功能；全螢幕、自動播放、剪貼簿維持瀏覽器預設（同源允許）
    '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    '  X-Frame-Options: SAMEORIGIN',
    '',
  ].join('\n')
}

export function transformHtml(html: string, url: string, env: CspEnv = {}) {
  const content = readFileSync(resolve(dir, 'content.html'), 'utf8').trim()
  const out = html
    // CrazyGames SDK 與它上方的註解
    .replace(/[ \t]*<!--[^>]*CrazyGames SDK[\s\S]*?-->\s*/, '')
    .replace(/[ \t]*<script src="https:\/\/sdk\.crazygames\.com\/[^"]*"><\/script>\s*/, '')
    // CSP 要放在所有資源之前
    .replace(
      /(<meta charset="[^"]*" \/>)/,
      `$1\n    <meta http-equiv="Content-Security-Policy" content="${esc(contentSecurityPolicy(env, { frameAncestors: false }))}" />`,
    )
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(SITE.title)}</title>`)
    .replace('</head>', `    ${headTags(url)}\n  </head>`)
    .replace('<div id="app"></div>', `<div id="app">\n${content}\n    </div>`)
  if (!out.includes('og:image') || !out.includes('id="seo"') || !out.includes('http-equiv="Content-Security-Policy"')) throw new Error('site plugin：index.html 結構改變，注入失敗')
  return out
}

// Web App Manifest：Android 安裝 / iOS 加入主畫面後全螢幕、橫向開啟（iOS 不支援鎖定方向，直拿時遊戲會提示轉向）
export function manifest() {
  return (
    JSON.stringify(
      {
        name: SITE.name,
        short_name: SITE.name,
        description: SITE.description,
        start_url: './',
        scope: './',
        display: 'fullscreen',
        orientation: 'landscape',
        background_color: SITE.themeColor,
        theme_color: SITE.themeColor,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
      },
      null,
      2,
    ) + '\n'
  )
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
  let env: CspEnv = {}
  return {
    name: 'elf-goblins-site',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir)
      // c.env 已合併 .env 檔與 process.env 中的 VITE_ 變數，和打包進遊戲的值一致
      env = c.env as CspEnv
    },
    transformIndexHtml: {
      order: 'pre',
      handler: (html, ctx) => (ctx.filename.endsWith('index.html') ? transformHtml(html, url, env) : html),
    },
    closeBundle() {
      if (!existsSync(outDir)) return
      cpSync(resolve(dir, 'public'), outDir, { recursive: true })
      writeFileSync(resolve(outDir, '_headers'), headersFile(env))
      writeFileSync(resolve(outDir, 'manifest.webmanifest'), manifest())
      writeFileSync(resolve(outDir, 'robots.txt'), robots(url))
      writeFileSync(resolve(outDir, 'sitemap.xml'), sitemap(url))
      writeFileSync(resolve(outDir, 'llms.txt'), readFileSync(resolve(dir, 'llms.txt'), 'utf8').replaceAll('{{SITE_URL}}', url))
    },
  }
}
