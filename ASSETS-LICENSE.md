# 素材授權 / Assets License

Copyright (C) 2026 MichaelHo. **保留所有權利 / All Rights Reserved.**

以下內容**不屬於** GPL v3 授權範圍，著作權與相關權利由作者保留。
The material listed below is **not** licensed under the GNU GPL v3. All rights are reserved by the author.

## 保留內容 / Reserved Material

### 1. 角色設計 / Character Designs

女精靈與哥布林的角色設計，包括外型、比例、配色、服裝、配件與表情，以及產生這些角色的檔案：
The designs of the Elf and Goblin characters, including their shape, proportions, color schemes, outfits, accessories and expressions, and the files that produce them:

- `public/models/**`（例如 `elf.glb`、`harp.glb` / e.g. `elf.glb`, `harp.glb`）
- `tools/blender/build_elf.py`
- `tools/blender/out/**`（例如 `elf.blend` / e.g. `elf.blend`）
- `src/game/models.ts` 中定義角色外觀的部分：顏色常數 `C`、`createGoblin()`、`createElf()` 及它們使用的建模輔助函式
  The character-appearance parts of `src/game/models.ts`: the color constants `C`, `createGoblin()`, `createElf()`, and the modeling helpers they use
  （該檔中的型別 `Pose`、`AnimFlags`、`CharacterModel` 屬於 GPL 程式碼，方便你替換成自己的角色）
  (The types `Pose`, `AnimFlags` and `CharacterModel` in that file are GPL code, so you can swap in your own characters.)

### 2. 圖片與圖示 / Images and Icons

- `src/assets/art/**`（例如 `elf-card.png`、`goblin-card.png` / e.g. `elf-card.png`, `goblin-card.png`）
- `public/favicon.png`
- `public/apple-touch-icon.png`
- `public/icons.svg`
- `public/og-image.jpg`
- `docs/` 內的截圖與圖片 / screenshots and images in `docs/`

### 3. 名稱與標誌 / Names and Logos

- 快逃啊，哥布林！女精靈來山洞了
- Elf & Goblins
- 以及任何近似、易混淆的名稱或標誌 / and any confusingly similar names or logos

## ✅ 允許的用途 / Permitted Uses

只要**不涉及商業用途**，你可以：
As long as the use is **non-commercial**, you may:

- 在本機下載、執行、遊玩本專案
  Download, run and play this project locally
- 為了研究、教學、個人學習而閱讀、分析、修改保留內容，例如研究建模方式、渲染技術、動畫
  Read, analyze and modify the reserved material for research, teaching or personal study, e.g. studying the modeling, rendering or animation techniques
- 在論文、課程、技術文章中引用或展示保留內容，並註明出處「MichaelHo《快逃啊，哥布林！女精靈來山洞了》」
  Quote or show the reserved material in papers, courses or technical articles, credited as "MichaelHo, *Elf & Goblins* (快逃啊，哥布林！女精靈來山洞了)"
- 錄製或直播原版遊戲的遊玩過程，以及撰寫評論
  Record or stream gameplay of the original game, and write reviews

## ❌ 禁止的用途 / Prohibited Uses

未經作者書面許可，不得：
Without the author's written permission, you may not:

- 在你散布、上架或發行的任何作品中使用保留內容，包括遊戲、應用程式、網站與遊戲平台（例如 Poki、CrazyGames、itch.io、App Store、Google Play），不論是否收費
  Use the reserved material in any work you distribute, publish or release, including games, apps, websites and game portals (e.g. Poki, CrazyGames, itch.io, App Store, Google Play), whether paid or free
- 製作與本專案角色、圖片、名稱**相同或實質近似**的作品，包括重新建模、描圖、換色、小幅修改後的版本
  Create characters, images or names that are **identical or substantially similar** to this project's, including re-modeled, traced, recolored or slightly altered versions
- 使用本專案的名稱或標誌，或讓人誤以為你的作品是原作、由原作者製作或認可
  Use this project's names or logos, or imply that your work is the original or is made or endorsed by the original author
- 將保留內容用於任何商業用途，或用於訓練、生成相似角色或圖片
  Use the reserved material for any commercial purpose, or to train or generate similar characters or images

## 想用這份程式碼做自己的遊戲？ / Building Your Own Game?

歡迎！程式碼依 GPL v3 授權，你可以拿去做自己的遊戲，甚至商業發行，但必須：
You're welcome to! The code is GPL v3 licensed. You may build your own game with it, even commercially, provided that you:

1. 換上你自己的角色、圖片和遊戲名稱
   Replace the characters, images and game name with your own
2. 依 GPL v3 公開你的完整原始碼
   Release your complete source code under the GPL v3
3. 遵守 [NOTICE.md](NOTICE.md) 中的署名與標示條款
   Follow the attribution and marking terms in [NOTICE.md](NOTICE.md)

其他授權需求請聯繫作者：<https://github.com/michelo851a1203>
For any other licensing, contact the author: <https://github.com/michelo851a1203>
