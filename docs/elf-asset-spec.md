# 女精靈（豎琴手）角色：資源清單、製作規格與整合說明

> ⚠️ **目前遊戲內的 `elf.glb` 是暫時預覽版（TEMPORARY PREVIEW）。**
> 它由 `tools/blender/build_elf.py` 以 Python 程序化產生（掃掠管狀髮束、旋轉面裙子、numpy 手繪臉部貼圖），
> 用來驗證 GLB → 骨架 → 動畫 → 遊戲整合的完整管線。它**不等於**參考圖的美術品質：
> 沒有手部手指、臉部是貼圖而非雕刻、布料沒有真正的層次與摺痕、刺繡是程序化圖案。
> 正式美術請依本文件第 2 節規格製作，直接覆蓋同名檔案即可，程式不需修改。

---

## 1. 資源清單（Asset Manifest）

| 檔案 | 用途 | 目前狀態 |
|---|---|---|
| `public/models/elf/elf.glb` | 角色本體：LOD0 + LOD1 兩組 SkinnedMesh 共用一副骨架、9 個動作、4 張內嵌 WebP 貼圖，EXT_meshopt_compression 壓縮 | 預覽版（2.7 MB） |
| `public/models/elf/harp.glb` | 豎琴道具，原點＝握把（pillar 中段），執行時掛到 `prop_harp` 骨 | 預覽版（69 KB） |
| `tools/blender/build_elf.py` | 可重現的建模 / 綁骨 / 動畫 / 匯出腳本 | — |
| `tools/blender/out/elf.blend` | 可編輯的 Blender 原始檔 | — |
| `tools/validate-glb.mjs` | GLB 驗證工具（`npm run validate:elf`） | — |

程式端的路徑與名稱定義在 `src/game/elf/assets.ts`（`ELF_ASSETS`、`ELF_CLIPS`、`ELF_NODES`、`ELF_SPRING_CHAINS`）。

### 1.1 `elf.glb` 必要內容

**節點**
- `ElfMesh_LOD0`（桌機，約 46k 頂點）、`ElfMesh_LOD1`（遠距 / 低階裝置，約 14k 頂點）
- 骨架根 `ElfRig` → `root` → `hips` …

**骨頭（Blender 名稱；three.js 載入後會去掉 `.`，例如 `hand.L` → `handL`）**

| 類別 | 骨頭 | 說明 |
|---|---|---|
| 身體 | `root hips spine chest neck head` | 由動作驅動 |
| 手臂 | `shoulder.L/R upper_arm.L/R forearm.L/R hand.L/R` | 由動作驅動 |
| 腿 | `thigh.L/R shin.L/R foot.L/R` | 由動作驅動 |
| 頭髮 | `hair_L1..3 hair_C1..3 hair_R1..3` | **程式彈簧驅動**（動作中的軌道會被忽略） |
| 裙擺 | `skirt_F1..2 skirt_L1..2 skirt_B1..2 skirt_R1..2` | **程式彈簧驅動** |
| 紗袖 | `sleeve.L/R` | **程式彈簧驅動**（含重力，手舉起時下垂） |
| 道具 | `prop_harp`（子骨於 `hand.L`，不變形） | 豎琴掛點 |

**動作（名稱必須完全一致）**

| 名稱 | 循環 | 遊戲觸發 |
|---|---|---|
| `Idle` | ✓ | 站立（移動量 < 0.12） |
| `Walk` | ✓ | 移動量 0.12 – 0.62，播放速度隨移動量 |
| `Run` | ✓ | 移動量 > 0.62 |
| `Play` | ✓ | E 彈奏豎琴（pose `play`） |
| `Cast` | 一次 | Q 魔法凝視（pose `cast`，雙手比心） |
| `Strike` | 一次 | F 打暈（pose `attack`） |
| `Capture` | ✓ | R 打包哥布林（pose `pack`） |
| `Stunned` | ✓ | 被哥布林大招 / 攪局打斷（pose `stunned`） |
| `Victory` | ✓ | 精靈獲勝時（`ElfCharacter.setVictory(true)`） |

**材質（glTF PBR metallic-roughness）**

| 材質 | 貼圖 | 備註 |
|---|---|---|
| `M_Face` | `elf_face`（1024²，sRGB，WebP） | 臉部正投影 UV |
| `M_Hair` | `elf_hair`（256×512） | 沿髮束方向的髮絲條紋 |
| `M_Dress` | `elf_skirt`（1024²） | 象牙白 + 金色藤蔓刺繡 |
| `M_Overskirt` | `elf_overskirt`（512²） | 森林綠 + 金邊 |
| `M_Sheer` | — | 半透明紗袖：程式設為 `transparent / depthWrite=false / DoubleSide` |
| `M_Skin M_Bodice M_Gold M_Gem M_Petal M_LeafGold M_LeafGreen M_Shoe` | — | 純色 PBR |

**座標與尺寸**：glTF Y-up、角色面向 **+Z**、腳底在 y=0、身高約 1.73 m（含花冠）。

**載入需求**：GLB 使用 `EXT_meshopt_compression` 與 `EXT_texture_webp`，請用 `createElfLoader()`（已設定 `MeshoptDecoder`）載入。

### 1.3 身體比例（`build_elf.py` 的 `SK` 表）

以動漫美型 7.2 頭身為基準（頭高 H ≈ 0.24 m），所有骨頭、手、袖子、金環、項鍊、胸衣都從這張表推導：

| 位置 | 高度 | 比例 |
|---|---|---|
| 頭頂 / 下巴 | 1.72 / 1.48 m | 0 / 1H |
| 肩線（斜方肌斜向肩膀，脖子只露出約 1/3 頭高） | 1.40–1.45 m | 1.35H |
| 胸線 | 1.26 m | 2H |
| 腰（最細，寬 0.165 m）＝ 手肘、裙頭（高腰） | 1.075 m | 2.75H |
| 大轉子（最寬，0.337 m，約與肩同寬） | 0.875 m | — |
| 跨下 ＝ 手腕 | 0.85–0.885 m | 約身高一半 |
| 膝 | 0.475 m | 5.3H |
| 腳踝 | 0.08 m | — |

身體以 **metaball** 沿骨架建立（`metaball_body()`），關節與骨段的場自然融合，肩膀、脖子、腋下、跨下都是圓順過渡，再以 voxel remesh（7.2 mm）得到均勻拓撲；早期 Skin 修改器版本在分岔處會留下硬接縫。
身體細節：圓潤的三角肌肩帽、斜方肌（脖子中段斜向肩膀）、近水平的鎖骨與胸骨上窩、鎖骨下飽滿過渡到胸部、圓頂形胸部（外側延伸到腋下）、腰椎前凸、臀部、肩胛、膝蓋骨。
項鍊、寶石、上臂金環以最近表面投影貼在皮膚上（`on_skin()`），身形調整後不會浮空或陷入。

臉型以使用者提供的動漫角色模型為**造型參考**（只量測輪廓比例：下半臉寬度比例 `W_RATIO`、正面深度曲線 `D_PROFILE`，沒有複製該模型的網格或貼圖；該模型為 MMD 二次創作，授權不明，不可放入專案或遊戲）。
臉型（`FACE_SHAPE`）：顴骨（眼睛下緣）最寬，以下為直線下顎收到小而圓的下巴（V 臉）；下巴是頭的最低點，下顎底線往脖子斜上；側臉正面幾乎垂直、小鼻子、鼻唇距離短。
被長裙與胸衣完全蓋住的身體面在匯出前刪除（`strip_hidden_body()`），減少頂點並避免穿模；`.blend` 內仍保留完整流程可重建。

### 1.2 `harp.glb`
- 單一網格 `Harp`，原點在握把，豎琴平面為 XY、琴弦面朝 ±Z，高約 0.53 m。
- 掛點偏移在 `ElfCharacter.ts` 的 `HARP_OFFSET`，可用預覽頁的滑桿調整後複製回程式。

---

## 2. 正式美術製作規格（給 3D 美術）

以參考圖（金髮豎琴精靈、綠金長袍精靈、凱爾特豎琴）為準：

**角色造型**
- 年輕成年精靈女性，約 7 頭身（遊戲鏡頭距離 6–9 m，臉可略大以利辨識），身高 1.70–1.80 m。
- 明顯的女性身形：較豐滿的胸部、收窄的腰、略寬的臀（預覽版的比例由 `build_elf.py` 的 `BUST` 參數與 Skin 半徑控制）；彈奏 / 比心動作時手臂需避開胸部不穿模。
- 香檳金長捲髮，長及大腿；分成 3 條可動髮片（對應 `hair_L/C/R`），髮梢呈波浪；瀏海與臉側髮束綁頭骨。
- 大而有神的祖母綠眼睛、柔和五官、自然微笑；**臉部需雕刻**（鼻樑、唇形、下顎），眼睛可用貼圖 + 高光片。
- 細長尖耳（約頭長 0.6 倍），向後上方。
- 白色小花與金葉花冠，正中一顆綠寶石。
- 象牙白長袍：胸衣 + 多層裙；森林綠外層前開襟、金色滾邊與藤蔓刺繡；半透明喇叭紗袖與一層透明外紗。
- 完整手部（5 指，需 `hand.L/R` 以下的手指骨，可選）。

**技術規格**
- LOD0 ≤ 35k 三角形、LOD1 ≤ 10k 三角形；材質 ≤ 10 個（盡量合併成貼圖集）。
- 貼圖：BaseColor（sRGB）+ ORM（線性）+ Normal，臉 / 頭髮 1024²，服裝 2048² 貼圖集；行動版可提供 1024² 版本或 KTX2。
- 每頂點最多 4 個骨頭權重；骨頭名稱與階層需與 1.1 節相同（可新增，不可改名）。
- 半透明只限紗袖 / 外紗，且使用單層，避免 overdraw。
- 動作以 30 fps 製作，名稱如上表；`hair_* / skirt_* / sleeve.*` 骨**不要**打關鍵影格（程式會覆蓋）。
- 匯出：glTF 2.0 binary、+Y up、套用縮放、`Export Deformation Bones Only` 關閉（需保留 `prop_harp`）。

**豎琴**
- 凱爾特豎琴：S 形琴頸與前柱帶繩結浮雕（Normal map）、藤蔓與白花纏繞、11–15 根琴弦。
- 高 0.45–0.55 m，原點設在左手握持處。

---

## 3. 程式架構與整合說明

```
src/game/elf/
  assets.ts           資源路徑、動作 / 骨頭名稱
  ElfCharacter.ts     GLB 載入、AnimationMixer、豎琴掛點、LOD、材質最佳化、dispose
  ElfAnimState.ts     純邏輯動畫狀態機（姿勢 + 移動量 → 動作 / 淡入時間 / 播放速度）
  SecondaryMotion.ts  頭髮 / 裙擺 / 紗袖的彈簧次級動畫（mixer 之後疊加）
  ElfMagicFx.ts       花瓣、金色音符、魔法陣（物件池）、愛心粒子
  dispose.ts          幾何 / 材質 / 貼圖 / 骨架釋放
src/preview/elfPreview.ts + elf-preview.html   獨立角色預覽頁
```

**對既有遊戲的改動（最小侵入）**
- `entities.ts`：`Elf` 改用 `new ElfCharacter({ fallback: createElf() })`。GLB 載入完成前（或載入失敗時）仍顯示原本的程序化精靈，`CharacterModel` 介面不變，所以操作、物理、碰撞、AI、技能數值與時間**完全沒動**。
- `Game.ts`：
  - 建立 `ElfMagicFx`，在 Q / E / F / R 既有特效旁**額外**加上新特效（原特效保留）。
  - 建立 RoomEnvironment PMREM 作為 `scene.environment`（只影響 PBR 材質，即 GLB 精靈；場景其他卡通材質不受影響）。
  - 結算畫面時繼續更新精靈動畫（勝利動作），精靈獲勝時呼叫 `setVictory(true)`。
  - `dispose()` 釋放精靈、特效與環境貼圖。
- `models.ts` 未修改（`createElf()` 作為 fallback 保留）。

**效能**
- 粒子沿用 `FxSystem` 的環形緩衝（單一 draw call），`ElfMagicFx` 重複使用同一個 spec 物件；魔法陣使用 10 個固定物件池。
- 次級動畫與 LOD 的計算全部使用模組層級的暫存向量，每幀不配置記憶體。
- LOD：相機距離 > 16 m 切到 LOD1、< 13 m 切回（遲滯）；觸控裝置或 ≤4 核 / ≤4 GB 記憶體固定 LOD1。
- 精靈沒有新增任何動態光源。

---

## 4. 驗證清單

| 項目 | 方法 | 結果 |
|---|---|---|
| GLB 結構、內嵌貼圖、材質 | `npm run validate:elf`、`tests/elfAssets.test.ts` | ✅ |
| 朝向 +Z、身高 1.75 m、腳在 y=0 | `tests/elfCharacter.test.ts`（相容性） | ✅ |
| 骨架 40 根、9 個動作 | 驗證腳本 + 測試 | ✅ |
| 載入 / 失敗 fallback / 載入前 dispose | `tests/elfCharacter.test.ts` | ✅ |
| 動畫轉換、遲滯、一次性動作重播 | `tests/elfAnimState.test.ts` | ✅ |
| 資源釋放（幾何 / 材質 / 貼圖 / mixer） | `tests/elfCharacter.test.ts` | ✅ |
| 特效物件池、熱路徑無配置 | `tests/elfMagicFx.test.ts` | ✅ |
| 遊戲實測：移動 → Run、E 彈奏（豎琴 + 音符 + 魔法陣）、Q 愛心、F → Strike、R → Capture → 捕獲完成、勝利動作、再玩一次 | Chrome 實機（`?fast=120`） | ✅ 無 console 錯誤 |
| 哥布林模式：AI 精靈的動作切換、LOD 切換 | Chrome 實機 | ✅ |
| `npm run build`（含 elf-preview.html） | — | ✅ |

執行：

```bash
npm test               # 32 個測試
npm run validate:elf   # GLB 驗證
npm run dev            # 遊戲：/  ；角色預覽：/elf-preview.html
# 重新產生模型（Blender 5.x）：
blender -b -P tools/blender/build_elf.py
```

---

## 5. 尚待美術加強的部分

- **整體造型**：程序化幾何，輪廓與參考圖仍有明顯落差 → 依第 2 節重新建模。
- **臉**：已用程序化雕刻加上鼻樑 / 鼻頭、上下唇與嘴角、唇下溝與下巴、眼窩 / 眉骨 / 顴骨，以及收窄的 V 字下顎（`build_elf.py` 的 `sculpt_face()` 與 `FACE` 參數）。仍是高斯形狀的組合，細節不及手工雕刻；眼睛與嘴線仍是貼圖；沒有表情 morph（眨眼 / 張嘴），GLB 版需加 shape key。
- **手**：已有手掌與五指（自然微彎、權重綁在 `hand.L/R`，`build_hands()`），但手指沒有骨頭，彈奏時不會個別撥弦；手指形狀為管狀，指甲與關節細節需美術補上。
- **脖子**：已延伸進頭部內側（`neckm / neckt` 關節），下巴下方不再出現斷面。
- **頭髮**：管狀髮束，頂部兩側略鼓；缺少髮片層次與 alpha 髮梢。
- **服裝**：裙子為旋轉面，沒有真正的布料摺痕；刺繡為程序化圖案；紗袖略厚重。
- **豎琴握姿**：掛點以左手為準，右手撥弦位置是近似值。
- **貼圖**：沒有 normal / ORM 貼圖；行動版未提供壓縮貼圖（KTX2）。
