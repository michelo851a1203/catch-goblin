"""
Catch Goblin — 豎琴精靈（女精靈豎琴手）4K 版：Meshy.ai Ultra 高模 → 減面 / 重烘貼圖 / 綁骨 / 布料 / 動作 / LOD / 匯出

來源（Meshy.ai 產出，放在 repo 外層的 assets/豎琴精靈4K/）：
    Meshy_AI_Elven_Maiden_Ultra_4K_*_image-to-3d-texture.glb          高模（261 萬面、單一封閉曲面、4K 貼圖，UV 是 4399 個碎片島）
    Meshy_AI_Elven_Maiden_Rigged_*_animated_mixamo_All_animation.glb  Meshy 的綁骨版（只有 9.6k 面，臉只剩幾個三角形）：只取 Mixamo 骨架與權重
    （豎琴沿用 public/models/elf/harp.glb）

用法：
    blender -b -P tools/blender/build_harpist.py
    （HARPIST_ASSET_DIR 指定素材資料夾；HARPIST_REBAKE=1 強制重做第一階段；HARPIST_PREVIEW=1 另外輸出各動作的預覽圖）

輸出：
    public/models/elf/elf.glb            LOD0 + LOD1 共用骨架、9 個動作
    public/models/elf/elf_color_4k.webp  原尺寸色彩貼圖（非低階裝置延遲載入）
    public/models/elf/elf_normal_4k.webp 由高模烘焙的切線空間法線貼圖
    tools/blender/out/harpist.blend

流程：
  A. 網格與貼圖（結果快取在 tools/blender/out/harpist_base.blend，來源或本檔 STAGE_A_VERSION 改變才重做）
     1. 高模焊接（匯入時沿 UV 縫裂成 4399 塊）、正規化成 1.7 m、腳底 z=0、面向 -Y
     2. 減面到 LOD0（6 萬面；與高模的表面誤差 p99 1.3 mm）、臉部再細分一層貼回高模，修掉薄布料正反兩面互相穿插的面
     3. 重新展開 UV（臉部島放大）、由高模烘焙 色彩 / 金屬粗糙 / 切線空間法線 三張 4K 貼圖
  B. 骨架與權重（不快取）
     1. 匯入 Meshy 的 Mixamo 骨架，權重以最近表面內插轉移過來（只沿用軀幹 / 頭 / 手掌 / 腳）
     2. 以頂點顏色 + 位置為種子做多源測地線分區（身體 / 頭髮 / 袖子 / 裙子），切開各部位融合的橋接面並補洞
     3. 關節依網格量測重設（Meshy 的膝關節偏高 11 cm）；肩膀 / 手臂 / 腿 / 裙擺 / 袖子 / 頭髮的權重重新計算
     4. 布料彈簧骨：裙擺 8×4、寬袖 6×3、背後長髮 3×3（遊戲端以 SecondaryMotion 驅動）
     5. 以雙四元數蒙皮把 A-pose 烘進綁定姿勢（肩膀不塌），袖子平移跟著手臂、披在裙子外面
  C. 道具骨 prop_harp、裙子碰撞輔助骨、9 個程序化動作（IK 步態）
  D. 貼圖縮小 / 另存 4K WebP、LOD1 減面、匯出 GLB（EXT_meshopt_compression）
"""
import bpy, bmesh, math, os, shutil, subprocess, sys, time
import numpy as np
from mathutils import Vector, Quaternion, Matrix

try:
    REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
except NameError:
    REPO = '/Users/michaelho/main/project/2026-10-20-side-hustle/goblin-game'
ASSET_DIR = os.environ.get('HARPIST_ASSET_DIR', os.path.join(os.path.dirname(REPO), 'assets', '豎琴精靈4K'))
SRC_HIGH = os.path.join(ASSET_DIR, 'Meshy_AI_Elven_Maiden_Ultra_4K_1114155441_image-to-3d-texture.glb')
SRC_RIG = os.path.join(ASSET_DIR, 'Meshy_AI_Elven_Maiden_Rigged_20261114_animated_mixamo_All_animation.glb')
OUT_GLB = os.path.join(REPO, 'public', 'models', 'elf')
OUT_BLEND = os.path.join(REPO, 'tools', 'blender', 'out')
BASE_CACHE = os.path.join(OUT_BLEND, 'harpist_base.blend')
PREVIEW_DIR = os.environ.get('HARPIST_PREVIEW_DIR', os.path.join(OUT_BLEND, 'harpist_preview'))

STAGE_A_VERSION = 6  # 第一階段的做法有變時 +1，快取就會失效
HEIGHT = 1.70  # 與 Meshy 綁骨版相同的正規化（骨架直接對得上）
LOD0_TRIS = 60000
LOD1_RATIO = 0.3
BAKE_SIZE = 4096
TEX_SIZE = 2048  # GLB 內嵌的尺寸；4K 另存 WebP
HIRES_QUALITY = 90
MIN_ROUGH = 0.0  # 非金屬布料的粗糙度下限；0 = 沿用素材原本的金屬粗糙貼圖（與紫晶精靈的做法相同）
# 減面後與高模的表面誤差 p99 1.3 mm、最大 4.6 mm；薄布料厚度約 1.6 mm 起
BAKE_CAGE = 0.0025
BAKE_RAY = 0.006
UV_MARGIN = 0.0009  # 島與島的間距（UV 單位）：4K 約 3.7 px。圖塊有四千多個，間距是貼圖使用率的主要成本（0.0018 時只有 29%）
FACE_UV_SCALE = 2.8  # 臉部 UV 圖塊放大（選角詳情頁會拉近看臉）
HEAD_UV_SCALE = 1.35  # 頭部其餘的圖塊（瀏海、耳朵、花飾）
MIN_SHELL = 0.0008  # 薄殼正反兩面互相切穿時，推回去之後至少相隔這個距離
CHART_ANGLE = 70  # UV 圖塊：面法線與圖塊平均法線的最大夾角（度）
CHART_MAX_ANGLE = 84  # 合併小圖塊時放寬到這個角度（仍不背對投影方向，投影不會重疊）
CHART_MIN = 48  # 少於這個面數的圖塊併入鄰居
FPS = 24

X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
Sn, Cs, TAU = math.sin, math.cos, 2 * math.pi
FWD = Vector((0, -1, 0))  # 角色面向 Blender -Y（glTF +Z）


def log(*a):
    print('[harpist]', *a)
    sys.stdout.flush()


def smooth(k):
    k = max(0.0, min(1.0, k))
    return k * k * (3 - 2 * k)


def lerp(a, b, k):
    return a + (b - a) * k


def vlerp(a, b, k):
    return Vector(a).lerp(Vector(b), k)


def smoothstep_np(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def activate(*obs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[-1]


def enum_ids(op_or_rna, prop):
    return [i.identifier for i in op_or_rna.bl_rna.properties[prop].enum_items]


# ═════════════════════════ A. 網格與貼圖 ═════════════════════════
def load_high():
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=SRC_HIGH)
    high = next(o for o in bpy.data.objects if o not in before and o.type == 'MESH')
    for o in [o for o in bpy.data.objects if o not in before and o is not high]:
        bpy.data.objects.remove(o, do_unlink=True)
    high.name = high.data.name = 'ElfHigh'
    activate(high)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # 匯入的網格沿 UV 縫裂開（4399 塊）：焊接回單一封閉曲面，減面才不會沿縫裂開
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=1e-6)
    bpy.ops.object.mode_set(mode='OBJECT')
    me = high.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    lo, hi = co.min(0), co.max(0)
    s = HEIGHT / (hi[2] - lo[2])
    # 外框中心放在 x = y = 0（Meshy 綁骨版也是這樣正規化）、腳底 z = 0
    me.transform(Matrix.Scale(s, 4) @ Matrix.Translation((-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2])))
    me.update()
    log(f'high poly {len(me.polygons)} faces, {len(me.vertices)} verts, scale {s:.4f}')
    return high


def decimate(high):
    activate(high)
    bpy.ops.object.duplicate()
    low = bpy.context.active_object
    low.name = low.data.name = 'ElfMesh_LOD0'
    dec = low.modifiers.new('Dec', 'DECIMATE')
    dec.ratio = LOD0_TRIS / len(low.data.polygons)
    bpy.ops.object.modifier_apply(modifier='Dec')
    me = low.data
    # 臉（頭部正面、耳朵）細分一層，新頂點貼回高模表面：選角詳情頁會拉近看，下巴 / 臉頰的輪廓不能有稜角
    from mathutils.bvhtree import BVHTree
    hb = bmesh.new()
    hb.from_mesh(high.data)
    tree = BVHTree.FromBMesh(hb)
    bm = bmesh.new()
    bm.from_mesh(me)
    inface = lambda c: 1.405 < c.z < 1.65 and c.y < -0.085
    key = lambda c: (round(c.x, 6), round(c.y, 6), round(c.z, 6))
    orig = {key(v.co) for v in bm.verts}
    edges = list({e for f in bm.faces if all(inface(v.co) for v in f.verts) for e in f.edges})
    nf = len(bm.faces)
    bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True)
    moved = 0
    for v in bm.verts:
        if key(v.co) in orig:
            continue
        loc, _, _, d = tree.find_nearest(v.co)
        if loc is not None and d < 0.004:
            v.co = loc
            moved += 1
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    log(f'face subdivide: {nf} -> {len(bm.faces)} faces, {moved} new verts snapped to the high poly')
    bm.to_mesh(me)
    bm.free()
    hb.free()
    for layer in list(me.uv_layers):
        me.uv_layers.remove(layer)
    for attr in [a for a in me.color_attributes]:
        me.color_attributes.remove(attr)
    if me.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    me.materials.clear()
    log(f'LOD0 {len(me.polygons)} faces, {len(me.vertices)} verts')
    return low


def separate_shells(low):
    """薄布料（袖子、裙片、髮片）是有厚度的封閉薄殼，高模最薄約 1.6 mm；減面後三角形變大，正反兩面會在彎曲處互相切穿
    （6 萬面中約 170 個面，深度多半不到 1 mm），內側的顏色就從外側一小塊一小塊地露出來。
    判定：面的正上方（沿法線往外一點點）以射線奇偶數判斷落在實體「裡面」，而且往外很近就碰到一個面對著自己的面
    ＝ 自己跑到對面那一層的另一邊去了。把這個面的頂點沿面法線推回對面那一層的外側。
    （往外先碰到「同向」的面是另一種情況：整個面埋在別的表面底下，本來就看不到，不處理——推出來反而穿幫）"""
    from mathutils.bvhtree import BVHTree
    me = low.data
    for it in range(3):
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.normal_update()
        bm.faces.ensure_lookup_table()
        tree = BVHTree.FromBMesh(bm)

        def inside(p, d):
            n, o = 0, p
            for _ in range(64):
                loc, _, _, _ = tree.ray_cast(o, d, 10)
                if loc is None:
                    break
                n += 1
                o = loc + d * 1e-6
            return n % 2 == 1

        push = {}
        for f in bm.faces:
            c, nrm = f.calc_center_median(), f.normal
            p = c + nrm * 2e-5
            loc, hn, _, dist = tree.ray_cast(p, nrm, 0.004)
            if loc is None or hn.dot(nrm) > -0.2 or not inside(p, nrm):
                continue
            for v in f.verts:
                d = push.get(v.index)
                off = nrm * (dist + MIN_SHELL)
                push[v.index] = off if d is None or off.length > d.length else d
        n = len(push)
        if n:
            bm.verts.ensure_lookup_table()
            for i, off in push.items():
                bm.verts[i].co += off
            bm.to_mesh(me)
        bm.free()
        log(f'shell pass {it}: moved {n} verts of crossed thin-shell faces')
        if not n:
            break
    me.update()


class Chart:
    """一個 UV 圖塊：沿固定方向 N 正投影。以 2D 空間雜湊記住已收進來的三角形，新的面投影後若與既有的面重疊就不收
    （捲髮是螺旋面、裙襬的荷葉邊一層疊一層：法線都在同一個方向的範圍內，投影後卻會疊在一起，烘焙時兩個面搶同一塊貼圖）"""
    CELL = 0.012

    def __init__(self, N):
        self.N = N.normalized()
        self.u = self.N.orthogonal().normalized()
        self.v = self.N.cross(self.u)
        self.cells = {}
        self.faces = []

    def tri(self, f):
        return [(l.vert.co.dot(self.u), l.vert.co.dot(self.v)) for l in f.loops]

    @staticmethod
    def _inside(p, t):
        (ax, ay), (bx, by), (cx, cy) = t
        d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(d) < 1e-14:
            return False
        w0 = ((by - cy) * (p[0] - cx) + (cx - bx) * (p[1] - cy)) / d
        w1 = ((cy - ay) * (p[0] - cx) + (ax - cx) * (p[1] - cy)) / d
        return w0 > 0.02 and w1 > 0.02 and 1 - w0 - w1 > 0.02

    @staticmethod
    def _samples(t):
        (ax, ay), (bx, by), (cx, cy) = t
        mx, my = (ax + bx + cx) / 3, (ay + by + cy) / 3
        # 重心 + 往三個頂點各走一半（共 4 個內部取樣點）
        return [(mx, my)] + [((mx + x) / 2, (my + y) / 2) for x, y in t]

    def _range(self, t):
        xs, ys = [p[0] for p in t], [p[1] for p in t]
        c = self.CELL
        return range(int(math.floor(min(xs) / c)), int(math.floor(max(xs) / c)) + 1), range(int(math.floor(min(ys) / c)), int(math.floor(max(ys) / c)) + 1)

    def overlaps(self, t):
        rx, ry = self._range(t)
        pts = self._samples(t)
        seen = set()
        for i in rx:
            for j in ry:
                for k, o in self.cells.get((i, j), ()):
                    if k in seen:
                        continue
                    seen.add(k)
                    if any(self._inside(p, o) for p in pts) or any(self._inside(p, t) for p in self._samples(o)):
                        return True
        return False

    def add(self, f, t=None):
        t = t or self.tri(f)
        rx, ry = self._range(t)
        for i in rx:
            for j in ry:
                self.cells.setdefault((i, j), []).append((f.index, t))
        self.faces.append(f)


def chart_faces(bm):
    """把網格切成 UV 圖塊：由面積大的面開始往外長，面的法線與圖塊投影方向（種子面的法線）夾角在 CHART_ANGLE 以內、
    投影後又不與圖塊內既有的面重疊，就併入。太小的圖塊併入共用邊界最長的鄰居（同樣要通過角度與重疊檢查）。
    Blender 內建的 Smart UV Project 只用固定的幾個投影方向，這份網格（一綹一綹的捲髮）會被切成 1.3 萬個島，
    島與島之間的邊距吃掉大半張貼圖（實際使用率只有 22%）"""
    import heapq
    bm.faces.ensure_lookup_table()
    faces = bm.faces
    nf = len(faces)
    nrm = [f.normal.copy() for f in faces]
    area = [f.calc_area() for f in faces]
    adj = [[] for _ in range(nf)]
    for e in bm.edges:
        fs = e.link_faces
        if len(fs) == 2:
            L = e.calc_length()
            adj[fs[0].index].append((fs[1].index, L))
            adj[fs[1].index].append((fs[0].index, L))
    chart = [-1] * nf
    cos_lim = math.cos(math.radians(CHART_ANGLE))
    cos_max = math.cos(math.radians(CHART_MAX_ANGLE))
    charts = []
    for seed in sorted(range(nf), key=lambda i: -area[i]):
        if chart[seed] >= 0:
            continue
        cid = len(charts)
        ch = Chart(nrm[seed])
        charts.append(ch)
        chart[seed] = cid
        ch.add(faces[seed])
        heap = [(1 - nrm[j].dot(ch.N), j) for j, _ in adj[seed]]
        heapq.heapify(heap)
        while heap:
            _, j = heapq.heappop(heap)
            if chart[j] >= 0 or nrm[j].dot(ch.N) < cos_lim:
                continue
            t = ch.tri(faces[j])
            if ch.overlaps(t):
                continue
            chart[j] = cid
            ch.add(faces[j], t)
            for k, _ in adj[j]:
                if chart[k] < 0:
                    heapq.heappush(heap, (1 - nrm[k].dot(ch.N), k))
    n0 = len(charts)
    # 小圖塊合併
    alive = [True] * len(charts)
    for _ in range(6):
        merged = 0
        for c in sorted(range(len(charts)), key=lambda c: len(charts[c].faces)):
            ch = charts[c]
            if not alive[c] or len(ch.faces) >= CHART_MIN:
                continue
            border = {}
            for f in ch.faces:
                for j, L in adj[f.index]:
                    if chart[j] != c:
                        border[chart[j]] = border.get(chart[j], 0.0) + L
            for o, L in sorted(border.items(), key=lambda kv: -kv[1]):
                tgt = charts[o]
                if any(nrm[f.index].dot(tgt.N) < cos_max for f in ch.faces):
                    continue
                tris = [tgt.tri(f) for f in ch.faces]
                if any(tgt.overlaps(t) for t in tris):
                    continue
                for f, t in zip(ch.faces, tris):
                    tgt.add(f, t)
                    chart[f.index] = o
                alive[c] = False
                merged += 1
                break
        if not merged:
            break
    log(f'charts: {n0} grown, {sum(alive)} after merging small ones')
    return chart, charts


def unwrap(low):
    """重新展開 UV：自訂圖塊（chart_faces）→ 每個圖塊沿自己的投影方向正投影（1 UV 單位 = 1 m，各圖塊的像素密度一致）
    → 頭 / 臉的圖塊放大 → 依外形緊密排版。
    （試過 Blender 的最小拉伸攤平：圖塊有把手 / 破洞時會退化成一個圓盤，貼圖嚴重扭曲）"""
    t0 = time.time()
    activate(low)
    me = low.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    chart, charts = chart_faces(bm)
    uvl = bm.loops.layers.uv.verify()
    members = {}
    for f in bm.faces:
        members.setdefault(chart[f.index], []).append(f)
    scaled = 0
    for cid, comp in members.items():
        ch = charts[cid]
        area = sum(f.calc_area() for f in comp)
        c = sum((f.calc_center_median() * f.calc_area() for f in comp), Vector()) / max(area, 1e-12)
        k = 1.0
        if c.z > 1.36 and c.y < 0.02:
            k = HEAD_UV_SCALE
            if abs(c.x) < 0.085 and 1.40 < c.z < 1.60 and c.y < -0.12 and ch.N.y < 0:
                k = FACE_UV_SCALE
            scaled += 1
        for f in comp:
            f.smooth = True
            for l in f.loops:
                d = l.vert.co - c
                l[uvl].uv = (d.dot(ch.u) * k, d.dot(ch.v) * k)
    for e in bm.edges:
        fs = e.link_faces
        e.seam = len(fs) != 2 or chart[fs[0].index] != chart[fs[1].index]
    bm.to_mesh(me)
    bm.free()
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(rotate=True, rotate_method='ANY', scale=True, margin_method='FRACTION', margin=UV_MARGIN, shape_method='CONCAVE')
    bpy.ops.object.mode_set(mode='OBJECT')
    me.uv_layers.active.name = 'UVMap'
    log(f'unwrap: {len(members)} charts, {scaled} head charts enlarged, UV overlap {uv_overlap(me) * 100:.2f}%, {time.time() - t0:.0f}s')


def uv_overlap(me, R=2048):
    """檢查：被兩個以上的三角形蓋到的貼圖像素比例（應該接近 0）"""
    uv = np.empty(len(me.loops) * 2, dtype=np.float32)
    me.uv_layers.active.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 3, 2) * R
    cnt = np.zeros((R, R), dtype=np.uint8)
    for t in uv:
        lo = np.floor(t.min(0)).astype(int)
        hi = np.ceil(t.max(0)).astype(int) + 1
        xs, ys = np.arange(lo[0], hi[0]) + 0.5, np.arange(lo[1], hi[1]) + 0.5
        if not len(xs) or not len(ys):
            continue
        Xg, Yg = np.meshgrid(xs, ys)
        a, b, c = t
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-9:
            continue
        w0 = ((b[1] - c[1]) * (Xg - c[0]) + (c[0] - b[0]) * (Yg - c[1])) / d
        w1 = ((c[1] - a[1]) * (Xg - c[0]) + (a[0] - c[0]) * (Yg - c[1])) / d
        m = (w0 > 0.1) & (w1 > 0.1) & (1 - w0 - w1 > 0.1)
        yy, xx = np.nonzero(m)
        yy += lo[1]
        xx += lo[0]
        ok = (yy >= 0) & (yy < R) & (xx >= 0) & (xx < R)
        cnt[yy[ok], xx[ok]] += 1
    return float((cnt > 1).sum()) / max(1, int((cnt > 0).sum()))


def setup_cycles():
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        for dev_type in ('METAL', 'OPTIX', 'CUDA', 'HIP', 'ONEAPI'):
            try:
                prefs.compute_device_type = dev_type
                prefs.get_devices()
                if any(d.type == dev_type for d in prefs.devices):
                    for d in prefs.devices:
                        d.use = d.type == dev_type
                    sc.cycles.device = 'GPU'
                    log('bake device', dev_type)
                    break
            except TypeError:
                continue
    except Exception as e:  # 沒有 GPU 就用 CPU
        log('bake on CPU', e)
    sc.cycles.samples = 1


def high_images(high):
    """高模材質的三張貼圖：(色彩, 金屬粗糙, 法線)"""
    nt = high.data.materials[0].node_tree
    out = {}
    for l in nt.links:
        if l.from_node.type != 'TEX_IMAGE':
            continue
        if l.to_socket.name == 'Base Color':
            out['color'] = l.from_node
        elif l.to_node.type == 'NORMAL_MAP':
            out['normal'] = l.from_node
        elif l.to_node.type in ('SEPARATE_COLOR', 'SEPRGB', 'SEPARATE_RGB'):
            out['orm'] = l.from_node
    return out


def fill_misses(img, passes=24, mask=None):
    """烘焙沒打到高模的像素（alpha = 0）：由周圍有效像素往外擴（同時當作 UV 島的邊距），避免 mipmap 把背景色滲進島的邊緣"""
    W, H = img.size
    px = np.empty(W * H * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(H, W, 4)
    valid = (px[:, :, 3] > 0.5) if mask is None else mask.copy()
    rgb = px[:, :, :3].copy()
    covered = valid.copy()
    for _ in range(passes):
        if valid.all():
            break
        acc = np.zeros_like(rgb)
        cnt = np.zeros((H, W), dtype=np.float32)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            v = np.roll(valid, (dy, dx), (0, 1))
            c = np.roll(rgb, (dy, dx), (0, 1))
            acc += c * v[:, :, None]
            cnt += v
        new = ~valid & (cnt > 0)
        rgb[new] = acc[new] / cnt[new][:, None]
        valid |= new
    px[:, :, :3] = rgb
    px[:, :, 3] = 1.0
    img.pixels.foreach_set(px.ravel())
    img.update()
    return covered


def bake_maps(high, low):
    """由高模烘焙到 LOD0 的新 UV：色彩與金屬粗糙以「自發光」烘焙（不受光照 / 金屬度影響的原始貼圖值），法線為切線空間"""
    t0 = time.time()
    setup_cycles()
    sc = bpy.context.scene
    src = high_images(high)
    hmat = high.data.materials[0]
    nt = hmat.node_tree
    out_node = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output)
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    emit = nt.nodes.new('ShaderNodeEmission')

    mat = bpy.data.materials.new('M_Elf')
    mat.use_nodes = True
    low.data.materials.append(mat)
    lnt = mat.node_tree
    target = lnt.nodes.new('ShaderNodeTexImage')
    lnt.nodes.active = target

    activate(high, low)
    bake = sc.render.bake
    bake.use_selected_to_active = True
    bake.cage_extrusion = BAKE_CAGE
    bake.max_ray_distance = BAKE_RAY
    bake.margin = 0  # 邊距由 fill_misses 處理（連同島內沒打到的像素）
    bake.use_clear = True
    bake.normal_space = 'TANGENT'
    images = {}
    mask = None
    for key in ('color', 'orm', 'normal'):
        img = bpy.data.images.new(f'elf_{key}_bake', BAKE_SIZE, BAKE_SIZE, alpha=True, float_buffer=key == 'normal')
        img.colorspace_settings.name = 'sRGB' if key == 'color' else 'Non-Color'
        img.generated_color = (0, 0, 0, 0)
        target.image = img
        if key == 'normal':
            nt.links.new(bsdf.outputs[0], out_node.inputs['Surface'])
            bpy.ops.object.bake(type='NORMAL')
        else:
            nt.links.new(src[key].outputs['Color'], emit.inputs['Color'])
            nt.links.new(emit.outputs[0], out_node.inputs['Surface'])
            bpy.ops.object.bake(type='EMIT')
        # 有效範圍以色彩烘焙的 alpha 為準（法線烘焙會把整張圖的 alpha 都寫成 1）
        mask = fill_misses(img, mask=mask)
        log(f'bake {key}: UV coverage {mask.mean() * 100:.1f}%, {time.time() - t0:.0f}s')
        images[key] = img
    nt.links.new(bsdf.outputs[0], out_node.inputs['Surface'])
    lnt.nodes.remove(target)
    clean_normal_bake(images['normal'])
    return images


def clean_normal_bake(img):
    """切線空間法線不可能朝向表面後方（z < 0）：那是光線打到薄布料 / 髮片另一側的失敗樣本。淡回平面法線 (0, 0, 1)"""
    px = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    n = px[:, :3] * 2 - 1
    k = smoothstep_np(0.05, 0.35, n[:, 2])[:, None]
    n = n * k + np.array((0, 0, 1), dtype=np.float32) * (1 - k)
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-6)
    log(f'normal bake cleaned {(k[:, 0] < 0.99).mean() * 100:.1f}% px')
    px[:, :3] = n * 0.5 + 0.5
    img.pixels.foreach_set(px.ravel())
    img.update()


def build_material(low, images):
    """M_Elf：色彩 + 金屬粗糙 + 法線（glTF 匯出器認得的接法）"""
    mat = low.data.materials[0]
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tc = nt.nodes.new('ShaderNodeTexImage')
    tc.image = images['color']
    nt.links.new(tc.outputs['Color'], bsdf.inputs['Base Color'])
    to = nt.nodes.new('ShaderNodeTexImage')
    to.image = images['orm']
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(to.outputs['Color'], sep.inputs['Color'])
    nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    tn = nt.nodes.new('ShaderNodeTexImage')
    tn.image = images['normal']
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    mat.use_backface_culling = False


def stage_a():
    """高模 → LOD0 網格 + 三張 4K 貼圖，存成 harpist_base.blend（貼圖打包在檔案裡）"""
    stamp = f'{STAGE_A_VERSION}:{os.path.getmtime(SRC_HIGH):.0f}:{LOD0_TRIS}:{BAKE_SIZE}'
    if os.path.exists(BASE_CACHE) and os.environ.get('HARPIST_REBAKE') != '1':
        bpy.ops.wm.open_mainfile(filepath=BASE_CACHE)
        if bpy.context.scene.get('harpist_stamp') == stamp:
            log('stage A (cached)', BASE_CACHE)
            return bpy.data.objects['ElfMesh_LOD0']
    bpy.ops.wm.read_factory_settings(use_empty=True)
    high = load_high()
    low = decimate(high)
    separate_shells(low)
    activate(low)
    bpy.ops.object.shade_smooth()
    unwrap(low)
    images = bake_maps(high, low)
    build_material(low, images)
    hm = high.data
    bpy.data.objects.remove(high, do_unlink=True)
    bpy.data.meshes.remove(hm)
    for img in list(bpy.data.images):
        if img.users == 0:
            bpy.data.images.remove(img)
    for img in images.values():
        img.pack()
    bpy.context.scene['harpist_stamp'] = stamp
    os.makedirs(OUT_BLEND, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=BASE_CACHE)
    log('stage A saved', BASE_CACHE)
    return low


# ═════════════════════════ B. 骨架與權重 ═════════════════════════
def load_rig(low):
    """匯入 Meshy 的 Mixamo 綁骨版：套用 0.01 縮放、骨頭去掉 "mixamorig:" 前綴，把權重轉移到 LOD0（最近表面內插）。
    兩者是同一個高模減面而來、正規化方式相同，表面幾乎重合"""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=SRC_RIG)
    new = [o for o in bpy.data.objects if o not in before]
    rig = next(o for o in new if o.type == 'ARMATURE')
    src = next(o for o in new if o.type == 'MESH' and o.parent is rig)
    for o in [o for o in new if o not in (rig, src)]:
        bpy.data.objects.remove(o, do_unlink=True)  # Meshy 附帶的 Icosphere
    rig.name = rig.data.name = 'ElfRig'
    if rig.animation_data:
        rig.animation_data.action = None
    for act in list(bpy.data.actions):
        bpy.data.actions.remove(act)  # Mixamo 的 Walking / Running 不使用（步態由 build_actions 產生）
    activate(src, rig)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for b in rig.data.bones:
        b.name = b.name.replace('mixamorig:', '')
    for g in src.vertex_groups:
        g.name = g.name.replace('mixamorig:', '')
    # 對齊檢查
    from mathutils.bvhtree import BVHTree
    dg = bpy.context.evaluated_depsgraph_get()
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix()
    bpy.context.view_layer.update()
    tree = BVHTree.FromObject(low, dg)
    d = np.array([tree.find_nearest(src.matrix_world @ v.co)[3] for v in src.data.vertices])
    log(f'rig mesh vs LOD0: mean {d.mean() * 1000:.1f} mm, p99 {np.percentile(d, 99) * 1000:.1f} mm')
    mod = low.modifiers.new('WT', 'DATA_TRANSFER')
    mod.object = src
    mod.use_vert_data = True
    mod.data_types_verts = {'VGROUP_WEIGHTS'}
    mod.vert_mapping = 'POLYINTERP_NEAREST'
    mod.layers_vgroup_select_src = 'ALL'
    mod.layers_vgroup_select_dst = 'NAME'
    for g in src.vertex_groups:
        low.vertex_groups.new(name=g.name)
    activate(low)
    bpy.ops.object.modifier_apply(modifier='WT')
    sm = src.data
    bpy.data.objects.remove(src, do_unlink=True)
    bpy.data.meshes.remove(sm)
    low.parent = rig
    low.matrix_parent_inverse = Matrix()
    arm = low.modifiers.new('Armature', 'ARMATURE')
    arm.object = rig
    sc = bpy.context.scene
    sc.render.fps, sc.render.fps_base = FPS, 1.0
    return rig


# ───────────── 分區 ─────────────
# 高模是單一封閉曲面：頭髮、袖子、裙子、身體全部融合在一起。以頂點顏色 + 位置找出確定的種子，再用多源測地線分區
SEG = ('BODY', 'HAIR', 'SLEEVE', 'SKIRT')
ARM_Y = -0.11  # T-pose 手臂軸線（剖面量測）：y ≈ -0.11、z ≈ 1.385，上緣 1.41、下緣 1.36
ARM_Z = 1.385
SHOULDER_X, ELBOW_X, WRIST_X = 0.122, 0.30, 0.47
KNEE_Z = 0.52
KNEE_BLEND = 0.028  # 膝關節上下各這麼寬的範圍內由大腿過渡到小腿
ARM_DROP = 52  # A-pose：上臂由水平往下轉的角度（另外鎖骨下壓 CLAV_DROP）
CLAV_DROP = 6
SKIRT_C = (0.0, -0.06)
SKIRT_DIRS = [('F', 0), ('FL', 45), ('L', 90), ('BL', 135), ('B', 180), ('BR', -135), ('R', -90), ('FR', -45)]
SKIRT_Z = [0.95, 0.74, 0.52, 0.30, 0.06]
SLEEVE_X = [0.25, 0.34, 0.43]  # 每邊 3 條袖鏈：掛在上臂 / 前臂 / 前臂（T-pose 的 |x|）
SLEEVE_SEG = 3
HAIR_X = [('L', 0.1), ('C', 0.0), ('R', -0.1)]
HAIR_Z = [1.36, 1.22, 1.08, 0.93]
SLEEVE_TILT = 20
SKIRT_EDGE_MAX = 0.045  # 裙子上超過這個長度的邊細分
LAYER_RAY = 0.03  # 白色襯裙往外這個距離內有綠色外裙就視為「被蓋住」
LAYER_GAP = 0.012  # 被蓋住的襯裙表面往內推的距離
SLEEVE_CLEAR = 0.03  # 袖子披在裙子外面的間隙
CLOTH_PREFIX = ('skirt_', 'sleeve_', 'hair_')


def mesh_co_edges(me):
    m = me.data
    co = np.empty(len(m.vertices) * 3)
    m.vertices.foreach_get('co', co)
    ev = np.empty(len(m.edges) * 2, dtype=np.int64)
    m.edges.foreach_get('vertices', ev)
    return co.reshape(-1, 3), ev.reshape(-1, 2)


def vertex_colors(me):
    """每個頂點在色彩貼圖上的顏色（各角的平均）"""
    m = me.data
    n = len(m.vertices)
    img = bpy.data.images['elf_color_bake']
    W, H = img.size
    px = np.empty(W * H * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(H, W, 4)
    lv = np.empty(len(m.loops), dtype=np.int64)
    m.loops.foreach_get('vertex_index', lv)
    luv = np.empty(len(m.loops) * 2)
    m.uv_layers.active.data.foreach_get('uv', luv)
    luv = luv.reshape(-1, 2)
    lc = px[np.clip((luv[:, 1] * H).astype(int), 0, H - 1), np.clip((luv[:, 0] * W).astype(int), 0, W - 1), :3]
    col = np.zeros((n, 3))
    cnt = np.zeros(n)
    np.add.at(col, lv, lc)
    np.add.at(cnt, lv, 1)
    return col / np.maximum(cnt, 1)[:, None]


def read_weights(me):
    names = [g.name for g in me.vertex_groups]
    W = np.zeros((len(me.data.vertices), len(names)))
    for v in me.data.vertices:
        for g in v.groups:
            W[v.index, g.group] = g.weight
    return names, W


def write_weights(me, W, max_inf=4):
    """W：{骨名: 每個頂點的權重}。每個頂點保留最大的 4 個並正規化"""
    names = list(W)
    M = np.stack([np.asarray(W[k], dtype=float) for k in names], 1)
    M[M < 2e-3] = 0
    idx = np.argsort(-M, axis=1)[:, :max_inf]
    top = np.take_along_axis(M, idx, 1)
    top /= np.maximum(top.sum(1, keepdims=True), 1e-9)
    for g in list(me.vertex_groups):
        me.vertex_groups.remove(g)
    vg = [me.vertex_groups.new(name=k) for k in names]
    for v in range(len(M)):
        for k in range(max_inf):
            w = float(top[v, k])
            if w > 2e-3:
                vg[idx[v, k]].add([v], w, 'REPLACE')


def leg_dist(co):
    """到腿中心線的水平距離（兩腿在 x = ±0.045 左右、y ≈ -0.10，剖面量測）"""
    x, y, z = co.T
    return np.hypot(np.abs(x) - np.interp(z, [0.13, 0.52, 0.9], [0.036, 0.056, 0.064]), y - np.interp(z, [0.13, 0.52, 0.9], [-0.072, -0.08, -0.125]))


def segment(me):
    co, ev = mesh_co_edges(me)
    col = vertex_colors(me)
    x, y, z = co.T
    ax = np.abs(x)
    # 參考色：臉（膚色）與背後的頭髮
    band = (ax < 0.04) & (z > 1.43) & (z < 1.49)
    skin_ref = np.median(col[band & (y < y[band].min() + 0.025)], axis=0)
    hair_ref = np.median(col[(ax < 0.1) & (y > 0.06) & (z > 1.1) & (z < 1.3)], axis=0)
    ds, dh = np.linalg.norm(col - skin_ref, axis=1), np.linalg.norm(col - hair_ref, axis=1)
    # 膚色很淡，與白色布料只差在偏粉（r 明顯大於 g、b）
    skin = (ds < 0.13) & (ds < dh * 0.7) & (col[:, 0] - col[:, 2] > 0.06) & (col[:, 0] - col[:, 1] > 0.035)
    hairc = (dh < 0.16) & (dh < ds * 0.7)
    log('skin ref', skin_ref.round(3), 'hair ref', hair_ref.round(3), 'skin verts', int(skin.sum()), 'hair-colored', int(hairc.sum()))
    darm = np.hypot(y - ARM_Y, z - ARM_Z)
    dleg = leg_dist(co)
    # 髮色的種子要求整圈鄰居也是髮色（金色的滾邊 / 飾品顏色和頭髮很接近，但都是細線）
    nb_bad = np.zeros(len(co), dtype=bool)
    np.logical_or.at(nb_bad, ev[:, 0], ~hairc[ev[:, 1]])
    np.logical_or.at(nb_bad, ev[:, 1], ~hairc[ev[:, 0]])
    hair_core = hairc & ~nb_bad
    # 裙子的範圍：以骨盆下方為頂點的圓錐（T-pose 的袖尾垂到裙子外側、同樣的高度）
    rsk = np.hypot(x - SKIRT_C[0], y - SKIRT_C[1])
    cone = 0.2 + np.maximum(0.0, 0.95 - z) * 0.5
    seeds = {
        'BODY': (skin & ~((z < 1.36) & (y > 0.0) & (z > 0.9)))
                | ((ax < 0.09) & (y < -0.12) & (z > 1.0) & (z < 1.33))  # 胸腹正面
                | ((dleg < 0.05) & (z < 0.9)) | ((z < 0.12) & (rsk < 0.2))  # 腿、靴子
                | ((darm < 0.022) & (ax > 0.14))  # 手臂軸線附近（袖子包著的手臂）
                | ((ax > 0.19) & (ax < 0.28) & (z > 1.34)),  # 肩上的葉片荷葉邊：跟著上臂
        'HAIR': hair_core & (z > 0.9) & (ax < 0.3) & ((y > -0.06) | (z > 1.3)),
        'SLEEVE': (ax > cone + 0.02) & (z < 1.325) & (z > 0.55) & ~skin & ~hairc & (darm > 0.05),
        'SKIRT': (z < 0.86) & (z > 0.12) & (dleg > 0.11) & (rsk < cone) & ~skin,
    }
    import heapq
    n = len(co)
    adj = [[] for _ in range(n)]
    el = np.linalg.norm(co[ev[:, 0]] - co[ev[:, 1]], axis=1)
    for (a, b), d in zip(ev.tolist(), el.tolist()):
        adj[a].append((b, d))
        adj[b].append((a, d))
    lab = np.zeros(n, dtype=np.int64)
    dist = np.full(n, np.inf)
    h = []
    for L, k in enumerate(SEG):
        for v in np.nonzero(seeds[k])[0]:
            if dist[v] > 0:
                dist[v] = 0.0
                lab[v] = L
                h.append((0.0, int(v), L))
    heapq.heapify(h)
    while h:
        d, v, L = heapq.heappop(h)
        if d > dist[v]:
            continue
        for w, l in adj[v]:
            nd = d + l
            if nd < dist[w]:
                dist[w] = nd
                lab[w] = L
                heapq.heappush(h, (nd, w, L))
    log('segment', {k: int((lab == i).sum()) for i, k in enumerate(SEG)})
    return lab


def cut_bridges(me, lab):
    """會各自運動的部位之間，Meshy 把接觸處融合成「橋接面」：一動就被拉成長條。切開後把留下的破洞補起來
    （舊版只切不補，頭髮 / 袖子擺開時身體和背上就露出破洞）：
      頭髮 ↔ 袖子 / 裙子、袖子 ↔ 裙子、袖子 ↔ 軀幹（手臂除外）、左右腿內側"""
    B, H, S, K = (SEG.index(k) for k in SEG)
    bm = bmesh.new()
    bm.from_mesh(me.data)
    layer = bm.verts.layers.int.new('orig')
    for v in bm.verts:
        v[layer] = v.index
    kill = []
    for f in bm.faces:
        ls = {int(lab[v.index]) for v in f.verts}
        c = f.calc_center_median()
        if (H in ls and (S in ls or K in ls)) or (S in ls and K in ls):
            kill.append(f)
        elif S in ls and B in ls and abs(c.x) < 0.17:
            kill.append(f)
        elif ls == {B} and c.z < 0.86 and len({v.co.x > 0 for v in f.verts}) == 2:
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    # 面刪掉後留下的孤立邊也要刪：否則權重平滑時會沿著這些邊在兩個部位之間互相滲透
    bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context='EDGES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    # 切開後脫落的小碎片（幾個面的殘渣，會懸在半空中）
    seen, small = set(), []
    for v0 in bm.verts:
        if v0 in seen:
            continue
        comp, stack = [v0], [v0]
        seen.add(v0)
        while stack:
            v = stack.pop()
            for e in v.link_edges:
                w = e.other_vert(v)
                if w not in seen:
                    seen.add(w)
                    comp.append(w)
                    stack.append(w)
        if len(comp) < 120:
            small += comp
    bmesh.ops.delete(bm, geom=small, context='VERTS')
    # 補洞：新的面沿用邊界上一個角的 UV（整片同一個顏色，接觸處本來就互相遮住）
    uvl = bm.loops.layers.uv.active
    # 每個邊界環以「環的重心 + 扇形三角形」補起來（bmesh 內建的 holes_fill / edgeloop_fill 對這些不規則的邊界補不完整）
    ncap = 0
    seen_e = set()
    for e0 in [e for e in bm.edges if e.is_boundary]:
        if e0 in seen_e or not e0.is_valid:
            continue
        loop, v, e = [], e0.verts[0], e0
        while e is not None and e not in seen_e:
            seen_e.add(e)
            loop.append(v)
            v = e.other_vert(v)
            e = next((x for x in v.link_edges if x.is_boundary and x not in seen_e), None)
        if len(loop) < 3:
            continue
        ref_loop = next((l for l in loop[0].link_loops), None)
        ref = ref_loop[uvl].uv.copy() if ref_loop else Vector((0.5, 0.5))
        c = bm.verts.new(sum((p.co for p in loop), Vector()) / len(loop))
        c[layer] = loop[0][layer]
        for i in range(len(loop)):
            try:
                f = bm.faces.new((loop[i], loop[(i + 1) % len(loop)], c))
            except ValueError:
                continue
            f.smooth = True
            for l in f.loops:
                l[uvl].uv = ref
            ncap += 1
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.verts.ensure_lookup_table()
    orig = np.array([v[layer] for v in bm.verts])
    bm.verts.layers.int.remove(layer)
    bm.to_mesh(me.data)
    bm.free()
    nv = len(me.data.vertices)
    me.data.validate(clean_customdata=False)  # 補洞可能產生重複 / 退化的面
    assert len(me.data.vertices) == nv
    me.data.update()
    log(f'cut {len(kill)} bridge faces, filled {ncap} cap faces')
    return lab[orig]


def refine_skirt(me, lab):
    """裙子上過長的邊細分：減面把平坦的綠色外裙留成幾公分大的三角形，底下打摺的白色襯裙卻很細。
    彈簧骨把裙子彎起來時，大三角形是一片平板、跟不上襯裙的弧度，襯裙就從外裙穿出來（綠裙上冒出白色碎片）。
    兩層的三角形大小相近之後，彎曲時的形狀才會一致。新頂點的 UV 由 bmesh 內插（貼圖不變）"""
    SK = SEG.index('SKIRT')
    n0 = len(me.data.vertices)
    bm = bmesh.new()
    bm.from_mesh(me.data)
    nf = len(bm.faces)
    for _ in range(2):
        edges = [e for e in bm.edges if e.calc_length() > SKIRT_EDGE_MAX and all(v.index < n0 and lab[v.index] == SK or v.index >= n0 for v in e.verts)]
        if not edges:
            break
        bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
        bm.verts.index_update()
    for f in bm.faces:
        f.smooth = True
    bm.to_mesh(me.data)
    bm.free()
    me.data.validate(clean_customdata=False)
    me.data.update()
    n1 = len(me.data.vertices)
    log(f'skirt refine: {nf} -> {len(me.data.polygons)} faces ({n1 - n0} new verts)')
    return np.concatenate([lab, np.full(n1 - n0, SK, dtype=lab.dtype)])


def separate_layers(me, lab):
    """裙子是好幾層布疊在一起（綠色外裙蓋在白色襯裙上），兩層之間只隔幾公釐到一兩公分。布料彈簧骨把裙子往後彎時，
    兩層的位移有落差，底下的白色襯裙就從綠色外裙一塊一塊地穿出來（奔跑時特別明顯）。
    找出「朝外的白色表面，往外 LAYER_RAY 之內被綠色外裙蓋住」的頂點，往內推 LAYER_GAP：
    被蓋住的表面本來就看不到，往內推不影響外觀，只是把兩層的間距拉開。
    （以顏色判斷外層：同一層布自己的皺褶也會互相面對，不能推）"""
    from mathutils.bvhtree import BVHTree
    SK = SEG.index('SKIRT')
    col = vertex_colors(me)
    green = (col[:, 1] > col[:, 0] * 1.08) & (col[:, 1] > col[:, 2] * 1.05) & (col[:, 1] < 0.75)
    bm = bmesh.new()
    bm.from_mesh(me.data)
    bm.normal_update()
    bm.faces.ensure_lookup_table()
    tree = BVHTree.FromBMesh(bm)
    axis = Vector((SKIRT_C[0], SKIRT_C[1], 0))
    is_green = lambda f: sum(green[v.index] for v in f.verts) >= 2
    cover = {}
    for f in bm.faces:
        if any(lab[v.index] != SK for v in f.verts) or is_green(f):
            continue
        c, n = f.calc_center_median(), f.normal
        radial = Vector((c.x - axis.x, c.y - axis.y, 0))
        if radial.length < 1e-6 or n.dot(radial.normalized()) < 0.25:
            continue
        loc, hn, hit, dist = tree.ray_cast(c + n * 1e-4, n, LAYER_RAY)
        if loc is None or hn.dot(n) > -0.3:
            continue
        g = bm.faces[hit]
        if not is_green(g):
            # 外裙的內側可能不是綠色：再往外找它的外側面（布料厚度 5 mm 內）
            loc2, _, hit2, _ = tree.ray_cast(loc + n * 1e-4, n, 0.005)
            if loc2 is None or not is_green(bm.faces[hit2]):
                continue
        for v in f.verts:
            cover[v.index] = cover.get(v.index, 0) + 1
    bm.verts.ensure_lookup_table()
    moved = 0
    for i, k in cover.items():
        v = bm.verts[i]
        if k < len(v.link_faces) * 0.5:
            continue  # 布片邊緣、露在外面的部分不動
        v.co -= v.normal * LAYER_GAP
        moved += 1
    bm.to_mesh(me.data)
    bm.free()
    me.data.update()
    log(f'layers: {int(green.sum())} green verts; pushed {moved} white verts covered by the green overskirt inward by {LAYER_GAP * 1000:.0f} mm')


def fix_joints(rig, me, lab):
    """Meshy 自動綁骨的關節位置不可靠（膝關節偏高 11 cm、肩關節在手臂上緣）：依網格實際量測重設"""
    co, _ = mesh_co_edges(me)
    body = lab == SEG.index('BODY')
    x, y, z = co.T
    P = {}
    for S, s in (('Left', 1), ('Right', -1)):
        def center(mask, fallback):
            if mask.sum() < 6:
                return Vector(fallback)
            lo, hi = co[mask].min(0), co[mask].max(0)
            return Vector((lo + hi) / 2)
        xs = x * s
        leg = body & (xs > 0) & (leg_dist(co) < 0.085)
        k = center(leg & (np.abs(z - KNEE_Z) < 0.025), (s * 0.047, -0.1, KNEE_Z))
        h = center(leg & (np.abs(z - 0.86) < 0.025), (s * 0.05, -0.105, 0.86))
        a = center(leg & (np.abs(z - 0.13) < 0.02), (s * 0.045, -0.07, 0.13))
        P[S] = dict(hip=Vector((h.x, h.y, 0.955)), knee=Vector((k.x, k.y, KNEE_Z)), ankle=Vector((a.x, a.y + 0.01, 0.13)),
                    sh=Vector((s * SHOULDER_X, ARM_Y, ARM_Z)), el=Vector((s * ELBOW_X, ARM_Y + 0.004, ARM_Z - 0.003)),
                    wr=Vector((s * WRIST_X, ARM_Y, ARM_Z)), clav=Vector((s * 0.03, ARM_Y, 1.405)))
    activate(rig)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = rig.data.edit_bones
    for b in eb:
        b.use_connect = False
    # 脊椎放回 x = 0
    for n_ in ('Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head'):
        d = eb[n_].head.x
        eb[n_].head.x = 0.0
    for n_, c in (('Hips', 'Spine'), ('Spine', 'Spine1'), ('Spine1', 'Spine2'), ('Spine2', 'Neck'), ('Neck', 'Head')):
        eb[n_].tail = eb[c].head
    eb['Head'].tail = eb['Head'].head + Vector((0, 0, 0.18))
    for S, s in (('Left', 1), ('Right', -1)):
        q = P[S]
        eb[f'{S}Shoulder'].head, eb[f'{S}Shoulder'].tail = q['clav'], q['sh']
        eb[f'{S}Arm'].head, eb[f'{S}Arm'].tail = q['sh'], q['el']
        eb[f'{S}ForeArm'].head, eb[f'{S}ForeArm'].tail = q['el'], q['wr']
        eb[f'{S}Hand'].head, eb[f'{S}Hand'].tail = q['wr'], q['wr'] + Vector((s * 0.09, 0, 0))
        eb[f'{S}UpLeg'].head, eb[f'{S}UpLeg'].tail = q['hip'], q['knee']
        eb[f'{S}Leg'].head, eb[f'{S}Leg'].tail = q['knee'], q['ankle']
        toe = eb[f'{S}ToeBase']
        eb[f'{S}Foot'].head = q['ankle']
        toe.head = Vector((q['ankle'].x, q['ankle'].y - 0.085, 0.035))
        eb[f'{S}Foot'].tail = toe.head
        toe.tail = toe.head + Vector((0, -0.05, 0))
        for n_ in ('Shoulder', 'Arm', 'ForeArm', 'Hand'):
            eb[S + n_].align_roll(Vector((0, 0, 1)))
        for n_ in ('UpLeg', 'Leg', 'Foot', 'ToeBase'):
            eb[S + n_].align_roll(FWD)
    for n_ in ('headfront', 'HeadTop_End'):
        if n_ in eb:
            eb.remove(eb[n_])
    bpy.ops.object.mode_set(mode='OBJECT')
    log('joints', {S: {k: tuple(round(c, 3) for c in v) for k, v in q.items() if k in ('hip', 'knee', 'ankle')} for S, q in P.items()})
    return P


def hats(tt, nseg):
    out = []
    for j in range(nseg):
        w = np.clip(1 - np.abs(tt - (j + 0.5)), 0, 1)
        if j == 0:
            w = np.where(tt < 0.5, 1.0, w)
        if j == nseg - 1:
            w = np.where(tt > nseg - 0.5, 1.0, w)
        out.append(w)
    return out


def sleeve_nodes(co, lab):
    """袖鏈節點：每條鏈從手臂下緣往下到該處袖子的最低點，等分成 SLEEVE_SEG 節"""
    sl = lab == SEG.index('SLEEVE')
    out = {}
    for S, s in (('L', 1), ('R', -1)):
        for i, sx in enumerate(SLEEVE_X):
            m = sl & (np.abs(co[:, 0] * s - sx) < 0.05)
            zmin = float(np.percentile(co[m, 2], 3)) if m.sum() > 10 else 0.9
            ym = float(np.median(co[m, 1])) if m.sum() > 10 else ARM_Y
            top = ARM_Z - 0.03
            out[f'sleeve_{S}{"ABC"[i]}'] = [Vector((s * sx, lerp(ARM_Y, ym, min(1, k / SLEEVE_SEG * 1.5)), lerp(top, zmin, k / SLEEVE_SEG))) for k in range(SLEEVE_SEG + 1)]
    return out


def skirt_nodes(co, lab):
    sk = co[lab == SEG.index('SKIRT')]
    rel = sk[:, :2] - np.array(SKIRT_C)
    ang = np.degrees(np.arctan2(rel[:, 0], -rel[:, 1]))
    rad = np.linalg.norm(rel, axis=1)
    out = {}
    for name, a in SKIRT_DIRS:
        da = np.abs((ang - a + 180) % 360 - 180)
        ar = math.radians(a)
        rs = []
        for zz in SKIRT_Z:
            m = (da < 28) & (np.abs(sk[:, 2] - zz) < 0.07)
            rs.append(float(np.percentile(rad[m], 55)) if m.sum() > 12 else None)
        for i in range(len(rs)):  # 正面開衩沒有布料：沿用上一節外推
            if rs[i] is None:
                rs[i] = (rs[i - 1] + 0.04) if i > 0 and rs[i - 1] else 0.17
            rs[i] = max(rs[i], 0.15)
        out[f'skirt_{name}'] = [Vector((SKIRT_C[0] + math.sin(ar) * r, SKIRT_C[1] - math.cos(ar) * r, zz)) for r, zz in zip(rs, SKIRT_Z)]
    return out


def hair_nodes(co, lab):
    hr = co[(lab == SEG.index('HAIR')) & (co[:, 1] > 0.0)]
    out = {}
    for name, hx in HAIR_X:
        nodes = []
        for zz in HAIR_Z:
            m = (np.abs(hr[:, 2] - zz) < 0.07) & (np.abs(hr[:, 0] - hx) < 0.08)
            yy = float(np.median(hr[m, 1])) if m.sum() > 8 else (nodes[-1].y if nodes else 0.06)
            nodes.append(Vector((hx * (1 + 0.12 * len(nodes)), yy, zz)))
        out[f'hair_{name}'] = nodes
    return out


def add_chain_bones(rig, chains, parent_of):
    activate(rig)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = rig.data.edit_bones
    for prefix, nodes in chains.items():
        prev = parent_of(prefix)
        for i in range(len(nodes) - 1):
            b = eb.new(f'{prefix}{i + 1}')
            b.head, b.tail = nodes[i], nodes[i + 1]
            b.parent = eb[prev]
            b.use_connect = i > 0
            b.use_deform = True
            prev = b.name
    bpy.ops.object.mode_set(mode='OBJECT')


def compute_weights(me, lab, J, chains):
    """權重：軀幹 / 頭 / 手掌 / 腳沿用 Meshy（Mixamo）的結果；肩膀與手臂、腿、裙擺、袖子、頭髮重新計算"""
    co, ev = mesh_co_edges(me)
    names, W0 = read_weights(me)
    gi = {k: i for i, k in enumerate(names)}
    n = len(co)
    x, y, z = co.T
    L = {k: lab == i for i, k in enumerate(SEG)}
    W = {}

    def add(name, w):
        W[name] = W.get(name, 0) + w

    spine = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head']
    core = np.stack([W0[:, gi[k]] for k in spine], 1)
    # 沒有軀幹權重的頂點（Meshy 給了手 / 腿）：依高度給一個
    zc = np.array([1.0, 1.11, 1.21, 1.32, 1.43, 1.52])
    fb = np.stack([np.clip(1 - np.abs(z - c) / 0.11, 0, 1) for c in zc], 1)
    fb[:, 0] = np.where(z < zc[0], 1.0, fb[:, 0])
    fb[:, -1] = np.where(z > zc[-1], 1.0, fb[:, -1])
    tot = core.sum(1, keepdims=True)
    core = np.where(tot > 0.3, core / np.maximum(tot, 1e-9), fb / np.maximum(fb.sum(1, keepdims=True), 1e-9))

    limb = np.zeros(n)  # 已分給四肢 / 布料的比例；其餘給軀幹
    # ── 手臂與肩膀（T-pose：沿 x 軸）──
    for S, s in (('Left', 1), ('Right', -1)):
        xs = x * s
        m = ((L['BODY'] & (z > 1.27)) | L['SLEEVE']) & (xs > 0.06)
        # 肩：以肩關節為中心、沿手臂 ±5 cm 的範圍內由軀幹過渡到上臂；腋下以下的軀幹側面不跟著手臂
        k_arm = smoothstep_np(SHOULDER_X - 0.05, SHOULDER_X + 0.05, xs)
        below = smoothstep_np(ARM_Z - 0.04, ARM_Z - 0.075, z) * (1 - smoothstep_np(SHOULDER_X + 0.015, SHOULDER_X + 0.06, xs))
        k_arm = k_arm * (1 - below) * m
        el = smoothstep_np(ELBOW_X - 0.035, ELBOW_X + 0.035, xs)
        wr = smoothstep_np(WRIST_X - 0.02, WRIST_X + 0.02, xs)
        clav = (smoothstep_np(0.035, 0.09, xs) * (1 - k_arm) * smoothstep_np(ARM_Z - 0.06, ARM_Z - 0.01, z) * 0.6) * (L['BODY'] & (xs > 0) & (z < 1.47) & (y < 0.0))
        # 袖子：手臂下緣以下的布料交給袖鏈
        depth = np.maximum(0.0, (ARM_Z - 0.03) - z)
        ks = smoothstep_np(0.01, 0.07, depth) * (L['SLEEVE'] & (xs > 0))
        arm = k_arm * (1 - ks)
        add(f'{S}Shoulder', clav)
        add(f'{S}Arm', arm * (1 - el))
        add(f'{S}ForeArm', arm * el * (1 - wr))
        add(f'{S}Hand', arm * wr)
        sx = np.array(SLEEVE_X)
        for i in range(len(sx)):
            wx = np.clip(1 - np.abs(xs - sx[i]) / (sx[1] - sx[0]), 0, 1)
            if i == 0:
                wx = np.where(xs < sx[0], 1.0, wx)
            if i == len(sx) - 1:
                wx = np.where(xs > sx[-1], 1.0, wx)
            nodes = chains[f'sleeve_{S[0]}{"ABC"[i]}']
            tt = (nodes[0].z - z) / max(1e-6, (nodes[0].z - nodes[-1].z)) * SLEEVE_SEG
            for j, hz in enumerate(hats(tt, SLEEVE_SEG)):
                add(f'sleeve_{S[0]}{"ABC"[i]}{j + 1}', ks * wx * hz * k_arm.clip(0, 1) + ks * wx * hz * (1 - k_arm) * (L['SLEEVE'] & (xs > 0)))
        limb += clav + arm + ks
    # ── 腿 ──
    for S, s in (('Left', 1), ('Right', -1)):
        m = L['BODY'] & (x * s > 0) & (z < 0.99)
        hp = smoothstep_np(0.87, 0.99, z)  # 髖：往上交還給骨盆
        # 膝 / 踝的過渡帶要窄：彎曲集中在關節。過渡帶寬（再加上後面的平滑）時彎曲被攤到整條腿，
        # 大腿到小腿變成一道連續的弧線——腿像橡皮管一樣「整條彎」，看不出膝蓋
        kn = smoothstep_np(KNEE_Z - KNEE_BLEND, KNEE_Z + KNEE_BLEND, z)
        an = smoothstep_np(0.115, 0.15, z)
        toe = smoothstep_np(-0.105, -0.135, y) * (1 - smoothstep_np(0.05, 0.09, z))
        leg = (1 - hp) * m
        add(f'{S}UpLeg', leg * kn)
        add(f'{S}Leg', leg * (1 - kn) * an)
        add(f'{S}Foot', leg * (1 - an) * (1 - toe))
        add(f'{S}ToeBase', leg * (1 - an) * toe)
        limb += leg
    # ── 裙擺 ──
    kt = (1 - smoothstep_np(0.88, 0.98, z)) * L['SKIRT']
    rel = co[:, :2] - np.array(SKIRT_C)
    ang = np.degrees(np.arctan2(rel[:, 0], -rel[:, 1]))
    nseg = len(SKIRT_Z) - 1
    hz = hats(np.interp(-z, -np.array(SKIRT_Z), np.arange(nseg + 1)), nseg)
    step = 360 / len(SKIRT_DIRS)
    for name, a in SKIRT_DIRS:
        wa = np.clip(1 - np.abs((ang - a + 180) % 360 - 180) / step, 0, 1)
        for j in range(nseg):
            add(f'skirt_{name}{j + 1}', kt * wa * hz[j])
    limb += kt
    # ── 頭髮：背後、下巴以下的部分交給髮鏈；頭上與胸前的髮束跟著頭 / 軀幹 ──
    kh = (1 - smoothstep_np(1.33, 1.43, z)) * smoothstep_np(-0.03, 0.03, y) * L['HAIR']
    hx = np.array([v for _, v in HAIR_X])
    nseg = len(HAIR_Z) - 1
    hz = hats(np.interp(-z, -np.array(HAIR_Z), np.arange(nseg + 1)), nseg)
    for i, (name, v) in enumerate(HAIR_X):
        wx = np.clip(1 - np.abs(x - v) / abs(hx[1] - hx[0]), 0, 1)
        if i == 0:
            wx = np.where(x > v, 1.0, wx)
        if i == len(HAIR_X) - 1:
            wx = np.where(x < v, 1.0, wx)
        for j in range(nseg):
            add(f'hair_{name}{j + 1}', kh * wx * hz[j])
    limb += kh
    limb = np.clip(limb, 0, 1)
    for i, k in enumerate(spine):
        add(k, core[:, i] * (1 - limb))
    # 在網格上平滑（各部位交界不要有折痕）
    order = list(W)
    M = np.stack([np.broadcast_to(np.asarray(W[k], dtype=float), (n,)) for k in order], 1)
    a, b = ev[:, 0], ev[:, 1]
    M0 = M.copy()
    for _ in range(3):
        acc = M.copy()
        deg = np.ones(n)
        np.add.at(acc, a, M[b])
        np.add.at(acc, b, M[a])
        np.add.at(deg, a, 1)
        np.add.at(deg, b, 1)
        M = acc / deg[:, None]
    # 膝蓋以下到髖部以下的腿不平滑（保留上面設定的窄過渡帶）；髖部往上漸進恢復平滑
    # （只限腿本身：腿中心線附近的頂點。身體分區裡貼著裙子的零星頂點仍要平滑，否則腿一動就把裙子扯出尖刺）
    leg_keep = (L['BODY'] & (z < 0.99)).astype(float) * (1 - smoothstep_np(0.80, 0.90, z)) * (1 - smoothstep_np(0.075, 0.095, leg_dist(co)))
    M = M0 * leg_keep[:, None] + M * (1 - leg_keep[:, None])
    M /= np.maximum(M.sum(1, keepdims=True), 1e-9)
    write_weights(me, {k: M[:, i] for i, k in enumerate(order)})
    log('weights', len(order), 'bones')


def skirt_cone(z):
    """裙子外緣的半徑（以 SKIRT_C 為軸的圓錐，剖面量測）"""
    return 0.2 + np.maximum(0.0, 0.95 - z) * 0.5


def drape_over_skirt(me):
    """手臂放下後，垂直下垂的袖尾會插進裙子的圓錐裡（兩層皺褶的布互相穿插，看起來像碎片）：
    把落在裙子範圍內的袖子頂點沿徑向推到裙子外側——袖子披在裙子外面。推移量乘上袖鏈權重，貼著手臂的布料不動"""
    m = me.data
    n = len(m.vertices)
    co = np.empty(n * 3)
    m.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    idx = [g.index for g in me.vertex_groups if g.name.startswith('sleeve_')]
    k = np.zeros(n)
    for v in m.vertices:
        k[v.index] = sum(g.weight for g in v.groups if g.group in idx)
    rel = co[:, :2] - np.array(SKIRT_C)
    r = np.linalg.norm(rel, axis=1)
    push = np.minimum(0.05, np.maximum(0.0, skirt_cone(co[:, 2]) + SLEEVE_CLEAR - r)) * smoothstep_np(0.3, 0.9, k) * (co[:, 2] < 0.98)
    co[:, :2] += rel / np.maximum(r, 1e-6)[:, None] * push[:, None]
    m.vertices.foreach_set('co', co.reshape(-1))
    m.update()
    log(f'drape: pushed {int((push > 1e-4).sum())} sleeve verts outside the skirt (max {push.max() * 100:.1f} cm)')


def bake_apose(rig, me, chains, lab=None):
    """把 A-pose 烘進綁定姿勢：遊戲端只有線性蒙皮，手臂若從 T-pose 放下 60° 肩膀會塌（體積流失、肩線下垂）。
    這裡用雙四元數蒙皮（保留體積）把手臂放下、鎖骨微降，袖鏈維持原本的世界方向（袖子平移跟著手臂、仍然垂直下垂），
    套用成新的網格與骨架 rest——遊戲中的姿勢離 rest 只有小角度，線性蒙皮也不會變形"""
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.matrix_basis = Matrix()
    bones = rig.data.bones
    P = rig.pose.bones

    def R(bname, ax, deg):
        Bm = bones[bname].matrix_local.to_3x3().inverted()
        return Quaternion(Bm @ ax, math.radians(deg))

    for S, s in (('Left', 1), ('Right', -1)):
        P[f'{S}Shoulder'].rotation_quaternion = R(f'{S}Shoulder', Y, s * CLAV_DROP)
        P[f'{S}Arm'].rotation_quaternion = R(f'{S}Arm', Y, s * ARM_DROP)
    bpy.context.view_layer.update()
    for name in chains:
        if not name.startswith('sleeve_'):
            continue
        pb = P[name + '1']
        M = pb.matrix.copy()
        rest = bones[name + '1'].matrix_local.to_3x3()
        # 袖尾往外斜 SLEEVE_TILT 度（整片剛性轉動，不變形）：披在裙子的圓錐外面
        tilt = Matrix.Rotation(math.radians((-1 if name[7] == 'L' else 1) * SLEEVE_TILT), 3, 'Y')
        pb.matrix = Matrix.Translation(M.translation) @ (tilt @ rest).to_4x4()
        bpy.context.view_layer.update()
    mod = next(m for m in me.modifiers if m.type == 'ARMATURE')
    mod.use_deform_preserve_volume = True
    co0, _ = mesh_co_edges(me)
    activate(me)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    co1, _ = mesh_co_edges(me)
    if lab is not None:
        mv = np.linalg.norm(co1 - co0, axis=1) > 0.002
        log('apose moved', {k: int((mv & (lab == i)).sum()) for i, k in enumerate(SEG)})
    drape_over_skirt(me)
    activate(rig)
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    mod = me.modifiers.new('Armature', 'ARMATURE')
    mod.object = rig
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix()
    bpy.context.view_layer.update()


def rig_character(low):
    rig = load_rig(low)
    lab = segment(low)
    lab = cut_bridges(low, lab)
    lab = refine_skirt(low, lab)
    separate_layers(low, lab)
    J = fix_joints(rig, low, lab)
    co, _ = mesh_co_edges(low)
    chains = {}
    chains.update(sleeve_nodes(co, lab))
    chains.update(skirt_nodes(co, lab))
    chains.update(hair_nodes(co, lab))

    def parent_of(prefix):
        if prefix.startswith('skirt_'):
            return 'Hips'
        if prefix.startswith('hair_'):
            return 'Spine2'
        side = 'Left' if prefix[7] == 'L' else 'Right'
        return side + ('Arm' if prefix.endswith('A') else 'ForeArm')

    add_chain_bones(rig, chains, parent_of)
    compute_weights(low, lab, J, chains)
    # 分區存成頂點色（除錯用，匯出前移除）
    ca = low.data.color_attributes.new('seg_debug', 'FLOAT_COLOR', 'POINT')
    pal = [(0.9, 0.6, 0.6), (1, 0.9, 0.1), (0.1, 0.6, 1), (0.2, 0.9, 0.3)]
    ca.data.foreach_set('color', np.array([(*pal[l], 1.0) for l in lab]).reshape(-1))
    if os.environ.get('HARPIST_NO_APOSE') != '1':
        bake_apose(rig, low, chains, lab)
    return rig, lab


# ═════════════════════════ C. 道具骨 / 碰撞輔助骨 / 動作 ═════════════════════════
SINK = 0.006
# 程序化步態：timeScale=1 時腳底相對地面的速度（m/s）；遊戲端 HARP_ANIM.gaitRef 要一致
WALK_FRAMES, WALK_REF = 14, 1.6
RUN_FRAMES, RUN_REF = 10, 6.5
HARP_X = Vector((-0.5, 0.85, 0.0)).normalized()  # 豎琴由前柱（握把）往共鳴箱的方向：朝向身體、略偏右


def add_helper_bones(rig):
    """prop_harp：豎琴掛點（左手，每個動作各自打關鍵影格讓琴身保持直立）；
    col_skirt1 / 2：裙子圓錐的碰撞膠囊端點（袖子的彈簧骨不會垂進裙子裡）"""
    activate(rig)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = rig.data.edit_bones
    h = eb['LeftHand']
    b = eb.new('prop_harp')
    b.head = h.head + (h.tail - h.head).normalized() * 0.06
    b.tail = b.head + Vector((0, 0, 0.1))
    b.align_roll(HARP_X.cross(Vector((0, 0, 1))))
    b.parent = h
    b.use_deform = False
    for name, zz in (('col_skirt1', 0.62), ('col_skirt2', 0.3)):
        c = eb.new(name)
        c.head = Vector((SKIRT_C[0], SKIRT_C[1], zz))
        c.tail = c.head + Vector((0, 0, -0.08))
        c.parent = eb['Hips']
        c.use_deform = False
    bpy.ops.object.mode_set(mode='OBJECT')


def foot_verts(me):
    idx = [vg.index for vg in me.vertex_groups if vg.name.endswith(('Foot', 'ToeBase'))]
    return np.array([v.index for v in me.data.vertices if sum(g.weight for g in v.groups if g.group in idx) > 0.5])


def eval_coords(me, idx=None):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = me.evaluated_get(dg)
    m = ev.to_mesh()
    co = np.empty(len(m.vertices) * 3)
    m.vertices.foreach_get('co', co)
    ev.to_mesh_clear()
    co = co.reshape(-1, 3)
    return co if idx is None else co[idx]


def channel_fcurves(act):
    try:
        return [fc for layer in act.layers for strip in layer.strips for bag in strip.channelbags for fc in bag.fcurves]
    except (AttributeError, IndexError):
        return list(act.fcurves)


def build_actions(rig, me):
    bones = rig.data.bones
    fidx = foot_verts(me)
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    keyed = [b.name for b in bones if not b.name.startswith(CLOTH_PREFIX) and not b.name.startswith('col_')]
    head0 = {b.name: b.head_local.copy() for b in bones}
    L = {S: dict(up=(head0[f'{S}ForeArm'] - head0[f'{S}Arm']).length, lo=(head0[f'{S}Hand'] - head0[f'{S}ForeArm']).length) for S in ('Left', 'Right')}
    LL = {S: dict(up=(head0[f'{S}Leg'] - head0[f'{S}UpLeg']).length, lo=(head0[f'{S}Foot'] - head0[f'{S}Leg']).length) for S in ('Left', 'Right')}
    SH = {S: head0[f'{S}Arm'] for S in ('Left', 'Right')}
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix()
    bpy.context.view_layer.update()
    lift = float(eval_coords(me, fidx)[:, 2].min())
    ANK = {S: head0[f'{S}Foot'] - Vector((0, 0, lift)) for S in ('Left', 'Right')}
    log(f'rest feet lift {lift:.3f}, arm {L["Left"]}, leg {LL["Left"]}')
    CHEST_Y = -0.27  # 胸部最前緣

    def upd():
        bpy.context.view_layer.update()

    def R(bname, *rots):
        Bm = bones[bname].matrix_local.to_3x3().inverted()
        q = Quaternion()
        for ax, deg in rots:
            q = Quaternion(Bm @ ax, math.radians(deg)) @ q
        return q

    CHILD = {'LeftArm': 'LeftForeArm', 'LeftForeArm': 'LeftHand', 'RightArm': 'RightForeArm', 'RightForeArm': 'RightHand',
             'LeftUpLeg': 'LeftLeg', 'LeftLeg': 'LeftFoot', 'RightUpLeg': 'RightLeg', 'RightLeg': 'RightFoot'}

    def aim(P, name, target):
        upd()
        pb = P[name]
        c = CHILD.get(name)
        head = pb.head.copy()
        cur = (P[c].head - head) if c else (pb.tail - head)
        rot = cur.normalized().rotation_difference((Vector(target) - head).normalized()).to_matrix()
        M = pb.matrix.copy()
        pb.matrix = Matrix.Translation(head) @ (rot @ M.to_3x3()).to_4x4()
        upd()

    def ik(P, up, lo, a, b, target, pole):
        upd()
        S0 = P[up].head.copy()
        d = Vector(target) - S0
        dist = min(d.length, (a + b) * 0.999)
        dn = d.normalized()
        ca = max(-1.0, min(1.0, (a * a + dist * dist - b * b) / (2 * a * dist)))
        pl = Vector(pole)
        pl = (pl - dn * pl.dot(dn)).normalized()
        aim(P, up, S0 + dn * a * ca + pl * a * math.sqrt(1 - ca * ca))
        aim(P, lo, S0 + dn * dist)

    def arm(P, S, hand, pole, wrist=None):
        ik(P, f'{S}Arm', f'{S}ForeArm', L[S]['up'], L[S]['lo'], hand, pole)
        if wrist is not None:
            upd()
            aim(P, f'{S}Hand', P[f'{S}Hand'].head + Vector(wrist))

    def leg(P, S, ankle, pole=FWD, flat=True, pitch=0.0):
        ik(P, f'{S}UpLeg', f'{S}Leg', LL[S]['up'], LL[S]['lo'], ankle, pole)
        if flat:
            upd()
            pb = P[f'{S}Foot']
            rest3 = bones[f'{S}Foot'].matrix_local.to_3x3()
            pb.matrix = Matrix.Translation(pb.head) @ (Matrix.Rotation(math.radians(pitch), 3, 'X') @ rest3).to_4x4()
            upd()

    def hips(P, off=(0, 0, 0), *rots):
        P['Hips'].rotation_quaternion = R('Hips', *rots)
        upd()
        pb = P['Hips']
        M = pb.matrix.copy()
        M.translation = head0['Hips'] + Vector(off)
        pb.matrix = M
        upd()

    def harp(P, grip=None, xdir=None):
        """豎琴掛點：原點在左手掌心（或指定位置），琴身直立（骨頭 +Y 朝上）、共鳴箱朝 xdir"""
        upd()
        h = P['LeftHand']
        o = Vector(grip) if grip is not None else h.head + (h.tail - h.head).normalized() * 0.06
        x = Vector(xdir) if xdir is not None else P['Hips'].matrix.to_3x3() @ (bones['Hips'].matrix_local.to_3x3().inverted() @ HARP_X)
        x = Vector((x.x, x.y, 0)).normalized()
        y = Vector((0, 0, 1))
        M = Matrix((x, y, x.cross(y))).transposed().to_4x4()
        M.translation = o
        P['prop_harp'].matrix = M
        upd()

    def reset_pose():
        for pb in rig.pose.bones:
            pb.matrix_basis = Matrix()
        upd()

    def make(name, length, fn, step, loop=True, ground=True):
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        rig.animation_data_create()
        rig.animation_data.action = act
        for f in range(0, length + 1, step):
            reset_pose()
            P = rig.pose.bones
            fn(f / length, P)
            if ground:
                low = eval_coords(me, fidx)[:, 2].min()
                pb = P['Hips']
                M = pb.matrix.copy()
                M.translation.z -= low + SINK
                pb.matrix = M
                upd()
            if 'prop_harp' not in P or P['prop_harp'].matrix_basis == Matrix():
                harp(P)
            for n_ in keyed:
                P[n_].keyframe_insert('rotation_quaternion', frame=f)
            for n_ in ('Hips', 'prop_harp'):
                P[n_].keyframe_insert('location', frame=f)
        if loop:
            for fc in channel_fcurves(act):
                if not any(md.type == 'CYCLES' for md in fc.modifiers):
                    fc.modifiers.new('CYCLES')
                fc.update()
        return act

    # ── 手臂的自然下垂位置（相對肩關節）：rest 是與垂直約 32° 的 A-pose，站姿再收一些、手肘微彎 ──
    def hang_hand(S, s, fwd=0.0, out=0.0, up=0.0):
        return SH[S] + Vector((s * (0.165 + out), -0.045 + fwd, -0.29 + up))

    def rest_arms(P, b=0.0):
        for S, s in (('Left', 1), ('Right', -1)):
            upd()
            sh = P[f'{S}Arm'].head
            arm(P, S, sh + (hang_hand(S, s, up=0.004 * b) - SH[S]), (s * 0.4, 0.9, 0), wrist=(s * 0.22, -0.2, -1))

    def gait(frames, speed, stance, lift_h, lean, twist, sway, narrow, pose_arms, flight=0.0, dip=0.012, toe=14.0, bob=1.0, kick=0.0):
        """IK 步態：支撐腳鎖在地面、以 speed（m/s，timeScale=1 時）往後移動 → 遊戲依實際速度調整播放速率就不滑步。
        骨盆高度＝支撐腳（留一點彎曲）碰得到地面的最高位置；騰空期在前後支撐之間內插並加上小跳"""
        cyc = frames / FPS
        D = speed * stance * cyc
        hip0 = {S: head0[f'{S}UpLeg'] for S in ('Left', 'Right')}

        def foot(S, t):
            p = (t + (0.0 if S == 'Left' else 0.5)) % 1.0
            a = ANK[S]
            if p < stance:
                fwd, h, q = D / 2 - p / stance * D, 0.0, None
            else:
                q = (p - stance) / (1 - stance)
                e = (1 - math.cos(math.pi * q)) / 2
                fwd, h = -D / 2 + e * D, lift_h * math.sin(math.pi * q) ** 0.9
                # 奔跑：離地後腳跟先往上收（小腿折向大腿），再往前擺——腿在身體下方收攏，不是伸直了往後甩
                h += kick * math.sin(math.pi * min(1.0, q * 1.7)) ** 2
                fwd += kick * 0.5 * math.sin(math.pi * min(1.0, q * 1.7)) ** 2 * (1 - q)
            return Vector((a.x * narrow, a.y - fwd, a.z + h)), q

        N = 64
        dz = []
        for i in range(N):
            lim = []
            for S in ('Left', 'Right'):
                tgt, q = foot(S, i / N)
                if q is None:
                    hp = hip0[S]
                    hd = math.hypot(tgt.x - hp.x, tgt.y - hp.y)
                    reach = (LL[S]['up'] + LL[S]['lo']) * 0.975
                    lim.append(tgt.z + math.sqrt(max(reach * reach - hd * hd, 0.0)) - hp.z)
            dz.append(min(lim) - dip if lim else None)
        for i in range(N):
            if dz[i] is None:
                j0 = next(k for k in range(1, N) if dz[(i - k) % N] is not None)
                j1 = next(k for k in range(1, N) if dz[(i + k) % N] is not None)
                a0, a1 = dz[(i - j0) % N], dz[(i + j1) % N]
                u = j0 / (j0 + j1)
                dz[i] = a0 + (a1 - a0) * u + flight * math.sin(math.pi * u)
        zmax = max(dz)
        dz = [zmax - (zmax - v) * bob for v in dz]

        def f(t, P):
            a, c = Sn(t * TAU), Cs(t * TAU)
            xx = t * N
            i0 = int(xx) % N
            zz = dz[i0] + (dz[(i0 + 1) % N] - dz[i0]) * (xx - int(xx))
            hips(P, (0.006 * sway * c, 0, zz - SINK), (Z, twist * a), (Y, sway * c), (X, lean * 0.35))
            P['Spine'].rotation_quaternion = R('Spine', (Z, -twist * 0.5 * a), (X, lean * 0.3))
            P['Spine1'].rotation_quaternion = R('Spine1', (Z, -twist * 0.4 * a), (Y, -sway * 0.5 * c), (X, lean * 0.2))
            P['Spine2'].rotation_quaternion = R('Spine2', (Z, -twist * 0.3 * a), (X, lean * 0.15))
            P['Neck'].rotation_quaternion = R('Neck', (X, -lean * 0.35))
            P['Head'].rotation_quaternion = R('Head', (Z, twist * 0.2 * a), (X, -lean * 0.4))
            for S in ('Left', 'Right'):
                tgt, q = foot(S, t)
                tgt.z -= SINK
                pitch = toe * math.sin(math.pi * q) * (1 - q) * 2 if q is not None else 0.0
                leg(P, S, tgt, (0.08 if S == 'Left' else -0.08, -1, 0.1), pitch=pitch)
            pose_arms(t, P, a)
        return f

    def swing_arms(amp, back, out):
        """步行 / 奔跑的上肢：手臂略為張開（寬袖不貼著裙子）、與對側腳同步小幅前後擺；跑步時雙手往後收、袖子在身後飄"""
        def f(t, P, a):
            for S, s in (('Left', 1), ('Right', -1)):
                upd()
                sh = P[f'{S}Arm'].head
                k = -a * s  # 左腳往前（a > 0 的前半）時左手往後
                off = hang_hand(S, s, fwd=back + amp * 0.09 * k, out=out, up=0.012 * amp * abs(k)) - SH[S]
                arm(P, S, sh + off, (s * 0.4, 0.9, 0), wrist=(s * 0.2, -0.15 + back * 2.0, -1))
        return f

    def idle(t, P):
        b = Sn(t * TAU)
        hips(P, (0, 0, 0), (Y, 1.5 * b), (Z, 2.5 * b))
        P['Spine1'].rotation_quaternion = R('Spine1', (X, 1.2 * b))
        P['Neck'].rotation_quaternion = R('Neck', (Z, 2 * b))
        P['Head'].rotation_quaternion = R('Head', (Y, 3 * Sn(t * TAU + 1)), (Z, 4 * b), (X, 3))
        rest_arms(P, b)

    def play(t, P):
        # 彈豎琴：左手在胸前左下方扶著前柱，右手在琴弦上撥，身體輕輕搖擺
        w = Sn(t * TAU * 4)
        sway = Sn(t * TAU)
        hips(P, (0, 0, 0), (Y, 2 * sway))
        P['Spine1'].rotation_quaternion = R('Spine1', (Z, 3 * sway), (X, 3))
        P['Neck'].rotation_quaternion = R('Neck', (X, 4))
        P['Head'].rotation_quaternion = R('Head', (X, 8), (Z, 7 * sway + 6), (Y, 4 * sway))
        grip = Vector((0.15, CHEST_Y - 0.15, 1.13))
        xd = HARP_X
        nrm = xd.cross(Vector((0, 0, 1)))  # 琴弦平面的法線（朝角色右前方）
        arm(P, 'Left', grip + Vector((0.02, 0.01, -0.02)), (1, 0.4, -0.5), wrist=(-0.5, -0.5, 0.6))
        pluck = grip + xd * 0.11 + nrm * 0.035 + Vector((0, 0, 0.05 + 0.03 * w))
        arm(P, 'Right', pluck + Vector((0, 0.005 * w, 0)), (-1, 0.5, -0.6), wrist=(0.75, -0.1, 0.5 + 0.2 * Sn(t * TAU * 4 + 0.8)))
        harp(P, grip, xd)

    def cast(t, P):
        # 魔法凝視：雙手在臉前比愛心
        k = smooth(t * 3)
        hips(P, (0, 0, 0))
        P['Head'].rotation_quaternion = R('Head', (Z, 8 * k), (X, -3 * k))
        hz = head0['Head'].z
        for S, s in (('Left', 1), ('Right', -1)):
            tgt = vlerp(hang_hand(S, s), (s * 0.035, CHEST_Y + 0.01, hz - 0.01), k)
            arm(P, S, tgt, (s * 1, 0.3, -0.5), wrist=vlerp((s * 0.22, -0.2, -1), (-s * 0.55, -0.1, 1), k))

    def strike(t, P):
        # 打暈：右手由後上方往前揮，上身跟著轉
        k = Sn(min(1, t * 1.6) * math.pi * 0.5)
        hips(P, (0, 0, 0), (Z, -6 * k))
        P['Spine'].rotation_quaternion = R('Spine', (Z, -12 * k))
        P['Spine1'].rotation_quaternion = R('Spine1', (Z, -9 * k), (X, 6 * k))
        rest_arms(P)
        upd()
        sh = P['RightArm'].head
        arm(P, 'Right', vlerp(sh + Vector((-0.2, 0.08, 0.2)), sh + Vector((0.02, -0.33, 0.0)), k), (-1, 0.3, -0.3), wrist=vlerp((-0.3, 0, 1), (0.2, -1, -0.2), k))

    def capture(t, P):
        k = Sn(t * TAU * 2)
        hips(P, (0, 0.03, -0.1), (X, 8))
        P['Spine'].rotation_quaternion = R('Spine', (X, 16))
        P['Spine1'].rotation_quaternion = R('Spine1', (X, 12))
        P['Head'].rotation_quaternion = R('Head', (X, 12))
        for S in ('Left', 'Right'):
            leg(P, S, ANK[S] + Vector((0, -0.04, -SINK)), (0, -1, 0))
        upd()
        ch = P['Spine2'].head
        arm(P, 'Left', ch + Vector((0.13, -0.33, -0.3 + 0.06 * k)), (1, 0.3, -0.3), wrist=(0, -0.5, -1))
        arm(P, 'Right', ch + Vector((-0.13, -0.33, -0.3 - 0.06 * k)), (-1, 0.3, -0.3), wrist=(0, -0.5, -1))

    def victory(t, P):
        # 勝利：雙手高舉、輕輕跳躍，寬袖順著手臂垂下
        hop = max(0.0, Sn(t * TAU))
        b = Sn(t * TAU)
        hips(P, (0, 0, 0.1 * hop), (Z, 5 * b))
        P['Spine1'].rotation_quaternion = R('Spine1', (X, -6))
        P['Head'].rotation_quaternion = R('Head', (X, -12), (Z, 6 * b))
        for S, s in (('Left', 1), ('Right', -1)):
            upd()
            sh = P[f'{S}Arm'].head
            arm(P, S, sh + Vector((s * (0.2 + 0.03 * hop), -0.04, 0.25 + 0.03 * hop)), (s * 1, 0.4, -0.4), wrist=(s * 0.3, -0.1, 1))
            leg(P, S, ANK[S] + Vector((0, 0, 0.1 * hop - SINK)), (0, -1, 0), pitch=25 * hop)

    def stunned(t, P):
        hips(P, (0, 0, 0), (Z, 4 * Sn(t * TAU + 1)))
        P['Spine1'].rotation_quaternion = R('Spine1', (Z, 6 * Sn(t * TAU + 0.5)))
        P['Head'].rotation_quaternion = R('Head', (Z, 16 * Sn(t * TAU)), (X, 8))
        for S, s in (('Left', 1), ('Right', -1)):
            arm(P, S, SH[S] + Vector((s * 0.2, -0.1, -0.22)), (s * 0.5, 0.6, -0.1), wrist=(s * 0.4, -0.3, -1))

    make('Idle', 60, idle, 3)
    # 走路：小步、兩腳收向中線、上身挺直、骨盆起伏小；奔跑：短支撐長騰空的輕跳步、上身微前傾、雙手往後收
    # 走路：小步、兩腳收向中線、上身挺直、骨盆起伏小。
    # 奔跑：遊戲裡精靈的移動速度是 7.4 m/s。原本每一步在地面上蹬 72 cm（支撐期腳相對骨盆前後各 36 cm），
    # 腿要伸到那麼遠骨盆就得壓低 10 cm——側面看是張開雙腿的弓箭步。改成小步快頻的輕跳步：
    # 蹬地只有 40 cm、其餘是騰空，骨盆維持在站姿的高度，後腳離地後收起，雙腿始終在裙子底下
    make('Walk', WALK_FRAMES, gait(WALK_FRAMES, WALK_REF, 0.58, 0.05, 2.5, 5, 2.5, 0.55, swing_arms(1.0, 0.0, 0.02), bob=0.4), 1, ground=False)
    make('Run', RUN_FRAMES, gait(RUN_FRAMES, RUN_REF, 0.15, 0.07, 15, 6, 2.0, 0.7, swing_arms(0.6, 0.15, 0.06), flight=0.025, dip=0.012, toe=30, bob=0.7, kick=0.16), 1, ground=False)
    make('Play', 48, play, 2)
    make('Cast', 24, cast, 2, loop=False)
    make('Strike', 14, strike, 1, loop=False)
    make('Capture', 16, capture, 2, ground=False)
    make('Victory', 48, victory, 2, ground=False)
    make('Stunned', 30, stunned, 2)
    rig.animation_data.action = bpy.data.actions['Idle']
    reset_pose()


# ═════════════════════════ D. 材質 / LOD / 匯出 ═════════════════════════
def save_webp(img, name, size):
    cwebp = shutil.which('cwebp')
    if not cwebp:
        log('找不到 cwebp，略過', name)
        return
    os.makedirs(OUT_GLB, exist_ok=True)
    tmp = os.path.join(OUT_BLEND, 'hires_tmp.png')
    hi = img.copy()
    if hi.size[0] > size:
        hi.scale(size, size)
    hi.filepath_raw = tmp
    hi.file_format = 'PNG'
    hi.save()
    bpy.data.images.remove(hi)
    out = os.path.join(OUT_GLB, name)
    subprocess.run([cwebp, '-quiet', '-q', str(HIRES_QUALITY), '-m', '6', '-sharp_yuv', tmp, '-o', out], check=True)
    os.remove(tmp)
    log('hires', out, os.path.getsize(out) // 1024, 'KB')


def prep_textures():
    """4K 色彩 / 法線另存 WebP（非低階裝置延遲載入），GLB 內嵌縮小的版本"""
    for key, name, size in (('color', 'elf_color', TEX_SIZE), ('orm', 'elf_orm', TEX_SIZE // 2), ('normal', 'elf_normal', TEX_SIZE)):
        img = bpy.data.images[f'elf_{key}_bake']
        if key == 'orm':
            # Meshy 的粗糙度約 0.4：布料在環境光下像緞面一樣反光，裙擺飄動時整片亮晃晃的。非金屬的部分提高到 MIN_ROUGH 以上（插畫感的霧面）
            px = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
            img.pixels.foreach_get(px)
            px = px.reshape(-1, 4)
            k = smoothstep_np(0.1, 0.3, px[:, 2])
            px[:, 1] = np.maximum(px[:, 1], MIN_ROUGH * (1 - k))
            img.pixels.foreach_set(px.ravel())
            img.update()
        if key != 'orm':
            save_webp(img, f'{name}_4k.webp', BAKE_SIZE)
        img.name = name
        if img.size[0] > size:
            img.scale(size, size)


# 臉部法線：往頭部橢球的法線混合，讓 cel shading 的明暗交界在臉上是乾淨的大塊形狀（與紫晶精靈相同的處理）
FACE_CENTER = Vector((0.0, -0.03, 1.55))
FACE_RADII = Vector((0.09, 0.13, 0.12))
FACE_BLEND = 0.85
FACE_EXTENT = (0.082, 0.1)  # 遮罩橢圓（x 半寬、z 半高），中心同 FACE_CENTER
LIMB_MASK = 0.8  # 四肢皮膚的遮罩值


def face_normals(me):
    """臉部遮罩 + 橢球法線：臉上原始法線跟著五官起伏，cel shading 的明暗交界會變成鼻翼 / 眼窩旁破碎的色塊；
    改用頭部橢球的法線後，臉上只剩隨光源方向移動的乾淨大塊陰影。
    遮罩存成頂點屬性 _FACEMASK，遊戲的 shader 以此柔化臉上的陰影、略過自身陰影貼圖、抑制臉上的法線貼圖"""
    from mathutils.kdtree import KDTree
    m = me.data
    n = len(m.vertices)
    co, ev = mesh_co_edges(me)
    col = vertex_colors(me)
    hg = me.vertex_groups['Head'].index
    hw = np.zeros(n)
    for v in m.vertices:
        for g in v.groups:
            if g.group == hg:
                hw[v.index] = g.weight
    ctr = np.array(FACE_CENTER)
    u = np.sqrt(((co[:, 0] - ctr[0]) / FACE_EXTENT[0]) ** 2 + ((co[:, 2] - ctr[2]) / FACE_EXTENT[1]) ** 2)
    region = (hw > 0.5) & (u < 1.05) & (co[:, 1] < ctr[1] - 0.015)
    # 膚色：偏粉（r > b；腮紅處 r - b 可達 0.25），g 與 b 接近；頭髮是金色，g 明顯大於 b；花飾是白色（r ≈ b）
    rb, gb = col[:, 0] - col[:, 2], col[:, 1] - col[:, 2]
    hair_like = gb > 0.11
    skin = (rb > 0.04) & ~hair_like & (col[:, 0] > 0.75)
    sk = np.nonzero(region & skin)[0]
    kd = KDTree(len(sk))
    for i in sk:
        kd.insert(Vector(co[i]), int(i))
    kd.balance()
    on_face = np.zeros(n, dtype=bool)
    for i in np.nonzero(region & ~hair_like)[0]:
        _, _, d = kd.find(Vector(co[i]))
        on_face[i] = d is not None and d < 0.004
    w = on_face * (1 - smoothstep_np(0.75, 1.05, u)) * smoothstep_np(ctr[1] - 0.015, ctr[1] - 0.06, co[:, 1])
    for _ in range(2):
        acc = w.copy()
        deg = np.ones(n)
        np.add.at(acc, ev[:, 0], w[ev[:, 1]])
        np.add.at(acc, ev[:, 1], w[ev[:, 0]])
        np.add.at(deg, ev[:, 0], 1)
        np.add.at(deg, ev[:, 1], 1)
        w = np.where(region, acc / deg, 0.0)
    w = np.clip(w * 1.3, 0, 1)
    # 四肢的皮膚（腿、手臂、手）：減面後的頂點法線有細微的起伏，法線貼圖在沒有切線屬性時又無法完全抵銷，
    # cel shading 的明暗交界剛好沿著腿走時會被放大成一圈一圈的橫紋。這些光滑的皮膚不需要法線貼圖的細節：
    # 遮罩給 LIMB_MASK（shader 依遮罩抑制法線貼圖、柔化明暗交界），頂點法線改用在皮膚上平滑過的版本
    names = [g.name for g in me.vertex_groups]
    limb_g = [i for i, k in enumerate(names) if k.endswith(('UpLeg', 'Leg', 'Arm', 'ForeArm', 'Hand'))]
    lw = np.zeros(n)
    for v in m.vertices:
        lw[v.index] = sum(g.weight for g in v.groups if g.group in limb_g)
    limb = skin & (lw > 0.5)
    bad = np.zeros(n, dtype=bool)  # 侵蝕一圈：皮膚與布料 / 飾品交界處不處理
    np.logical_or.at(bad, ev[:, 0], ~limb[ev[:, 1]])
    np.logical_or.at(bad, ev[:, 1], ~limb[ev[:, 0]])
    w2 = (limb & ~bad).astype(float)
    for _ in range(2):
        acc = w2.copy()
        deg = np.ones(n)
        np.add.at(acc, ev[:, 0], w2[ev[:, 1]])
        np.add.at(acc, ev[:, 1], w2[ev[:, 0]])
        np.add.at(deg, ev[:, 0], 1)
        np.add.at(deg, ev[:, 1], 1)
        w2 = np.where(limb, acc / deg, 0.0)
    vn = np.empty(n * 3)
    m.vertices.foreach_get('normal', vn)
    vn = vn.reshape(-1, 3)
    sm = vn.copy()
    a_, b_ = ev[:, 0], ev[:, 1]
    both = limb[a_] & limb[b_]
    a_, b_ = a_[both], b_[both]
    for _ in range(6):
        acc = sm.copy()
        np.add.at(acc, a_, sm[b_])
        np.add.at(acc, b_, sm[a_])
        sm = acc / np.maximum(np.linalg.norm(acc, axis=1, keepdims=True), 1e-9)
    attr = m.attributes.get('_FACEMASK') or m.attributes.new('_FACEMASK', 'FLOAT', 'POINT')
    attr.data.foreach_set('value', np.maximum(w, w2 * LIMB_MASK).astype(np.float32))
    lv = np.empty(len(m.loops), dtype=np.int64)
    m.loops.foreach_get('vertex_index', lv)
    cn = np.empty(len(m.loops) * 3)
    m.corner_normals.foreach_get('vector', cn)
    cn = cn.reshape(-1, 3)
    el = (co - ctr) / (np.array(FACE_RADII) ** 2)
    el /= np.linalg.norm(el, axis=1, keepdims=True)
    k = (w * FACE_BLEND)[lv][:, None]
    k2 = w2[lv][:, None]
    out = cn * (1 - k2) + sm[lv] * k2
    out = out * (1 - k) + el[lv] * k
    out /= np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-8)
    m.normals_split_custom_set([tuple(v) for v in out])
    log(f'limb skin mask {int((w2 > 0.5).sum())} verts; face mask {int((w > 0.5).sum())} verts (>0.5), {int((w > 0).sum())} verts (>0) of {int(region.sum())} in the face region')


def limit_influences(ob, n=4):
    for v in ob.data.vertices:
        gs = sorted(((g.group, g.weight) for g in v.groups), key=lambda x: -x[1])
        keep = gs[:n]
        tot = sum(w for _, w in keep) or 1.0
        for g, _ in gs[n:]:
            ob.vertex_groups[g].remove([v.index])
        for g, w in keep:
            ob.vertex_groups[g].add([v.index], w / tot, 'REPLACE')


def make_lod1(lod0, rig):
    activate(lod0)
    bpy.ops.object.duplicate()
    lod1 = bpy.context.active_object
    lod1.name = lod1.data.name = 'ElfMesh_LOD1'
    for m in [m for m in lod1.modifiers if m.type == 'ARMATURE']:
        lod1.modifiers.remove(m)
    dec = lod1.modifiers.new('Dec', 'DECIMATE')
    dec.ratio = LOD1_RATIO
    bpy.ops.object.modifier_apply(modifier='Dec')
    lod1.data.validate(clean_customdata=False)
    limit_influences(lod1)
    mod = lod1.modifiers.new('Armature', 'ARMATURE')
    mod.object = rig
    return lod1


def export(rig, objs):
    os.makedirs(OUT_GLB, exist_ok=True)
    activate(*objs, rig)
    path = os.path.join(OUT_GLB, 'elf.glb')
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True,
        export_animations=True, export_animation_mode='ACTIONS', export_skins=True,
        export_apply=False, export_yup=True, export_texcoords=True, export_normals=True,
        export_image_format='WEBP', export_image_quality=88, export_def_bones=False, export_force_sampling=True,
        export_optimize_animation_size=True, export_meshopt_compression_enable=True,
        # 不匯出切線：這份網格有 4500 個各自旋轉的 UV 圖塊，匯出器合併頂點後的切線與烘焙時不一致（皮膚上出現一圈圈波紋）；
        # three 沒有切線屬性時改用螢幕空間導數求切線空間，結果平滑
        export_tangents=False,
        export_attributes=True,  # _FACEMASK（臉部遮罩，遊戲的 cel shader 使用）
    )
    log('exported', path, os.path.getsize(path) // 1024, 'KB')


def preview(rig):
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'TEXTURE'
    sc.view_settings.view_transform = 'Standard'
    sc.render.resolution_x = sc.render.resolution_y = 480
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = 2.1
    for act in bpy.data.actions:
        rig.animation_data.action = act
        f0, f1 = act.frame_range
        for i, f in enumerate((f0, f0 + (f1 - f0) * 0.25, (f0 + f1) / 2, f1)):
            sc.frame_set(int(f))
            for view, loc in (('q', (2.6, -3.2, 1.25)), ('s', (4, 0, 0.9)), ('f', (0, -4, 0.9))):
                cam.location = Vector(loc)
                cam.rotation_euler = (Vector((0, 0, 0.9)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
                sc.render.filepath = os.path.join(PREVIEW_DIR, f'{act.name}_{i}_{view}.png')
                bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)
    rig.animation_data.action = bpy.data.actions['Idle']


def main(do_export=True):
    low = stage_a()
    rig, lab = rig_character(low)
    add_helper_bones(rig)
    low.data.color_attributes.remove(low.data.color_attributes['seg_debug'])
    activate(low)
    bpy.ops.object.shade_smooth()
    build_actions(rig, low)
    face_normals(low)  # 在所有改動拓撲的步驟之後、貼圖改名之前
    prep_textures()
    lod1 = make_lod1(low, rig)
    os.makedirs(OUT_BLEND, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_BLEND, 'harpist.blend'))
    if os.environ.get('HARPIST_PREVIEW') == '1':
        lod1.hide_render = True
        preview(rig)
        lod1.hide_render = False
    if do_export:
        export(rig, [low, lod1])
    log(f'HARP_GAIT_REF = {{ Walk: {WALK_REF:.2f}, Run: {RUN_REF:.2f} }}')


if __name__ == '__main__' or __name__ == '<run_path>' or __name__ == 'builtins':
    main(do_export=os.environ.get('HARPIST_NO_EXPORT') != '1')
