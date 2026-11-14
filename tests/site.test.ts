import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { manifest, normalizeSiteUrl, robots, sitePlugin, sitemap, transformHtml } from '../site/plugin.ts'

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
    expect(html).toMatch(/<title>Elf &amp; Goblins — [^<]+<\/title>/)
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1])
    expect(ld['@type']).toBe('VideoGame')
    expect(ld.url).toBe(URL_)
  })

  it('拿掉 CrazyGames SDK，並在 #app 放入爬蟲讀得到的介紹文字', () => {
    const html = transformHtml(indexHtml, URL_)
    expect(html).not.toContain('sdk.crazygames.com')
    expect(html).not.toContain('CrazyGames SDK')
    expect(html).toMatch(/<div id="app">[\s\S]*<h1>Elf &amp; Goblins<\/h1>[\s\S]*FAQ[\s\S]*<\/div>/)
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
})
