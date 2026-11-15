// 玩家暱稱的清理與過濾：多人連線時暱稱會顯示給陌生玩家（大廳列表、頭上名牌、提示訊息），
// CrazyGames 要求使用者產生的內容要有審核。房主收到暱稱時也會再過濾一次，其他玩家看到的一定是過濾後的版本。

export const NAME_MAX = 20

// 不雅字詞（比對前先轉小寫、去掉空白與符號、還原常見的數字替代字）。
// 刻意只放明確的髒話 / 歧視字眼；容易出現在正常字裡的（grape 的 rape、peacock 的 cock）放在下面「整個字比對」
const BLOCKED_SUBSTRINGS = [
  'fuck', 'shit', 'bitch', 'cunt', 'nigger', 'nigga', 'faggot', 'retard', 'whore', 'slut', 'pussy',
  'penis', 'vagina', 'porn', 'hitler', 'nazi', 'kkk', 'motherf', 'asshole', 'bastard', 'wanker', 'twat',
  '幹你', '幹妳', '操你', '肏', '屌', '機掰', '雞掰', '靠北', '靠杯', '婊', '賤人', '王八蛋', '去死', '智障', '腦殘', '支那', '強姦',
]
// 太短、容易出現在正常字裡的，只在整個名字（或用空白分開的單字）完全相同時才擋
const BLOCKED_WORDS = ['ass', 'fag', 'cum', 'tit', 'tits', 'sex', 'nig', 'jap', 'stfu', 'wtf', 'kys', 'rape', 'rapist', 'cock', 'dick', 'dildo', 'anal', 'boobs']

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', $: 's', '!': 'i', '|': 'i' }

// 轉小寫、還原數字替代字、去掉空白與符號
function norm(s: string) {
  return s
    .toLowerCase()
    .replace(/[0134578@$!|9]/g, (c) => LEET[c] ?? c)
    .replace(/[^\p{L}\p{N}]/gu, '')
}
// 再把重複字元縮成一個（fuuuck → fuck），只用在子字串比對
function squash(s: string) {
  return norm(s).replace(/(.)\1+/gu, '$1')
}

export function isProfane(name: string) {
  const flat = norm(name)
  const flatSquashed = squash(name)
  if (BLOCKED_SUBSTRINGS.some((w) => flat.includes(w) || flatSquashed.includes(w))) return true
  const words = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(norm)
  return [...words, flat].some((w) => BLOCKED_WORDS.includes(w))
}

// 暱稱：Unicode 正規化（全形 → 半形等）、去掉控制字元與不可見的格式字元（方向覆寫、零寬字元等，可用來假冒別人或弄亂版面）、
// 限制連續的組合記號（「Zalgo」字）、合併空白、限制長度；含不雅字詞時清空（顯示時改用「玩家 N」）
export function cleanName(v: unknown) {
  if (typeof v !== 'string') return ''
  const s = v
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u2028\u2029]/gu, '')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
  const name = [...s].slice(0, NAME_MAX).join('').trim()
  return isProfane(name) ? '' : name
}
