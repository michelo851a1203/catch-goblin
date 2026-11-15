import { describe, expect, it } from 'vitest'
import { cleanName, isProfane, NAME_MAX } from '../src/net/names'

describe('暱稱清理', () => {
  it('一般名字原樣保留（含中文、空白、數字）', () => {
    for (const n of ['Goblin King', '小哥布林', 'Player1', 'Grape Juice', 'Peacock', 'Hancock', 'Fu Xiaoming', 'Dickens', 'Assassin', 'Classic', 'Scott'])
      expect(cleanName(n), n).toBe(n)
  })
  it('去掉控制字元、方向覆寫與零寬字元，合併空白', () => {
    expect(cleanName('a‮evil​name')).toBe('aevilname')
    expect(cleanName('  a \t\n b  ')).toBe('a b')
    expect(cleanName('x\u0000y\u007f\u0085z')).toBe('xyz')
  })
  it('全形轉半形、限制連續組合記號（Zalgo）', () => {
    expect(cleanName('ＡＢＣ')).toBe('ABC')
    // q 沒有預組合的重音字形，NFKC 不會把記號合併進去
    expect(cleanName('q́̂̃̄̅o')).toBe('q́̂o')
  })
  it('限制長度（以字元計，不切壞 emoji）', () => {
    expect([...cleanName('🐸'.repeat(30))].length).toBe(NAME_MAX)
    expect(cleanName('a'.repeat(50)).length).toBe(NAME_MAX)
  })
  it('不雅字詞清空（含大小寫、數字替代、重複字、空白分隔、中文）', () => {
    for (const n of ['fuck', 'FuCk you', 'f u c k', 'fuuuuck', 'sh1t', 'b!tch', 'ass', 'big ass', 'n1gger', '幹你娘', '機掰人', 'rape'])
      expect(cleanName(n), n).toBe('')
  })
  it('非字串回傳空字串', () => {
    expect(cleanName(42)).toBe('')
    expect(cleanName(null)).toBe('')
    expect(isProfane('')).toBe(false)
  })
})
