import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy, headersFile, manifest, normalizeSiteUrl, robots, sitePlugin, sitemap, transformHtml } from '../site/plugin.ts'

const indexHtml = readFileSync(resolve(import.meta.dirname, '../index.html'), 'utf8')
const URL_ = 'https://elf-and-goblins.pages.dev/'

describe('網站版 SEO 外掛', () => {
  it('沒設定 SITE_URL 時不啟用（CrazyGames 版不受影響）', () => {
    expect(sitePlugin(undefined)).toBeNull()
    expect(sitePlugin('')).toBeNull()
  })

  it('網址一律以 / 結尾並去掉查詢字串', () => {
    expect(normalizeSiteUrl('https://elf-and-goblins.pages.dev')).toBe(URL_)
    expect(normalizeSiteUrl('https://elf-and-goblins.pages.dev/?a=1#x')).toBe(URL_)
    expect(normalizeSiteUrl('https://example.com/game')).toBe('https://example.com/game/')
    expect(() => normalizeSiteUrl('ftp://example.com')).toThrow()
  })

  it('注入社群卡片與 SEO 標籤，圖片使用絕對網址', () => {
    const html = transformHtml(indexHtml, URL_)
    expect(html).toContain(`<meta property="og:image" content="${URL_}og-image.jpg" />`)
    expect(html).toContain(`<meta property="og:url" content="${URL_}" />`)
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />')
    expect(html).toContain(`<link rel="canonical" href="${URL_}" />`)
    expect(html).toContain('<meta name="description"')
    expect(html).toMatch(/<title>Run, Goblins! — [^<]+<\/title>/)
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1])
    expect(ld['@type']).toBe('VideoGame')
    expect(ld.url).toBe(URL_)
  })

  it('拿掉 CrazyGames SDK，並在 #app 放入爬蟲讀得到的介紹文字', () => {
    const html = transformHtml(indexHtml, URL_)
    expect(html).not.toContain('sdk.crazygames.com')
    expect(html).not.toContain('CrazyGames SDK')
    expect(html).toMatch(/<div id="app">[\s\S]*<h1>Run, Goblins!<\/h1>[\s\S]*FAQ[\s\S]*<\/div>/)
    // 遊戲入口仍然存在
    expect(html).toContain('src="/src/main.ts"')
  })

  it('加入主畫面：manifest 以全螢幕橫向開啟，圖示檔案存在', () => {
    const html = transformHtml(indexHtml, URL_)
    expect(html).toContain('<link rel="manifest" href="manifest.webmanifest" />')
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />')
    const m = JSON.parse(manifest())
    expect(m.display).toBe('fullscreen')
    expect(m.orientation).toBe('landscape')
    expect(m.start_url).toBe('./')
    for (const i of m.icons) expect(existsSync(resolve(import.meta.dirname, '../site/public', i.src))).toBe(true)
  })

  it('robots.txt 與 sitemap.xml 指向網站網址', () => {
    expect(robots(URL_)).toContain(`Sitemap: ${URL_}sitemap.xml`)
    expect(sitemap(URL_, '2026-11-10')).toContain(`<loc>${URL_}</loc><lastmod>2026-11-10</lastmod>`)
  })

  it('網站版注入 CSP <meta>（不含 frame-ancestors），CrazyGames 版的 index.html 沒有', () => {
    expect(indexHtml).not.toContain('Content-Security-Policy')
    const html = transformHtml(indexHtml, URL_)
    const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)" \/>/)
    expect(m).not.toBeNull()
    const csp = m![1]
    expect(csp).toBe(contentSecurityPolicy({}, { frameAncestors: false }))
    expect(csp).not.toContain('frame-ancestors')
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(csp).not.toContain("'unsafe-eval'")
    expect(csp).toContain("object-src 'none'")
    // 預設 PeerJS 公用信令伺服器
    expect(csp).toMatch(/connect-src [^;]*https:\/\/0\.peerjs\.com [^;]*wss:\/\/0\.peerjs\.com/)
    // CSP 必須在任何 <script> / <link> 之前
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<link'))
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'))
  })

  it('connect-src 依建置時的 TURN Worker 與自架 PeerServer 設定', () => {
    const csp = contentSecurityPolicy({ VITE_TURN_URL: 'https://turn.example.workers.dev/ice', VITE_PEER_HOST: 'peer.example.com', VITE_PEER_PORT: '9000' })
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src '))!
    expect(connect.split(' ')).toEqual(expect.arrayContaining(['https://turn.example.workers.dev', 'https://peer.example.com:9000', 'wss://peer.example.com:9000']))
    expect(connect).not.toContain('0.peerjs.com')
    expect(contentSecurityPolicy({ VITE_PEER_HOST: 'peer.example.com', VITE_PEER_PORT: '443' })).toContain('wss://peer.example.com;')
    expect(() => contentSecurityPolicy({ VITE_TURN_URL: 'http://turn.example.com/ice' })).toThrow()
    expect(() => contentSecurityPolicy({ VITE_PEER_HOST: 'evil.com; script-src *' })).toThrow()
  })

  it('_headers（Cloudflare Pages）含 CSP 與安全標頭，並禁止被其他網站嵌入', () => {
    const h = headersFile({ VITE_TURN_URL: 'https://turn.example.workers.dev/ice' })
    const lines = h.trimEnd().split('\n')
    expect(lines[0]).toBe('/*')
    for (const l of lines.slice(1)) expect(l).toMatch(/^ {2}[A-Za-z-]+: \S/)
    expect(h).toContain(`  Content-Security-Policy: ${contentSecurityPolicy({ VITE_TURN_URL: 'https://turn.example.workers.dev/ice' })}\n`)
    expect(h).toContain("frame-ancestors 'self'")
    expect(h).toContain('https://turn.example.workers.dev')
    expect(h).toContain('  X-Content-Type-Options: nosniff\n')
    expect(h).toContain('  Referrer-Policy: strict-origin-when-cross-origin\n')
    expect(h).toContain('  X-Frame-Options: SAMEORIGIN\n')
    const pp = h.match(/Permissions-Policy: (.*)/)![1]
    expect(pp).toContain('camera=()')
    // 遊戲會用到全螢幕與自動播放音樂，不能關掉
    expect(pp).not.toMatch(/fullscreen|autoplay/)
  })

  it('CrazyGames 版（沒設定 SITE_URL）不輸出 _headers', () => {
    // 外掛不啟用 ⇒ 不會注入 CSP、不會寫 _headers；site/public 也沒有靜態 _headers 會被複製
    expect(sitePlugin(undefined)).toBeNull()
    expect(existsSync(resolve(import.meta.dirname, '../public/_headers'))).toBe(false)
    expect(existsSync(resolve(import.meta.dirname, '../site/public/_headers'))).toBe(false)
  })
})
