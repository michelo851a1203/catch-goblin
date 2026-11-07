"""
Catch Goblin — 女精靈（豎琴手）正式模型：Meshy.ai 網格 → 綁骨 / 權重 / A-pose / 動畫 / LOD / 匯出

來源（Meshy.ai 產出，放在 repo 外層的 assets/assets_豎琴精靈/）：
    Meshy_AI_Elf_Character_v2_Remeshed_30k_*.blend   角色（30k 三角形、T-pose、單一 4K 貼圖）
    Meshy_AI_Elven_Harp_Remeshed_15k_*.blend        豎琴（15k 三角形）

用法：
    blender -b -P tools/blender/build_elf_meshy.py
    （可用環境變數 ELF_ASSET_DIR 指定素材資料夾）

輸出（覆蓋預覽版，程式介面不變）：
    public/models/elf/elf.glb    LOD0 + LOD1 共用骨架 + 9 個動作
    public/models/elf/harp.glb   豎琴（原點 = 左手握持處）
    tools/blender/out/elf_meshy.blend

流程：
  1. 載入並正規化：身高 1.75 m、腳底 y=0、面向 -Y（glTF +Z）
  2. 以「多源測地線（Dijkstra）」把融合成一塊的網格分區：頭 / 軀幹 / 手臂 / 袖子 / 腿 / 頭髮 / 裙子
     （Meshy 網格是單一連通塊，頭髮、袖子、裙子與身體黏在一起，純空間距離無法區分）
  3. 依分區計算權重（頭髮 5 條鏈、裙擺 8 條鏈、袖子 2 節鏈、身體骨），在網格上平滑
  4. T-pose → A-pose：手臂以角度混合旋轉；袖子「垂墜」映射（貼近手臂的部分剛性跟隨，
     其餘沿下垂方向展開，避免剛性旋轉後插進身體）；臉側髮束往後推到手臂後方
  5. 以與 build_elf.py 相同的「世界軸 + 相對 rest」方式產生 9 個動作
  6. LOD1 減面、貼圖縮小為 WebP、匯出 GLB（EXT_meshopt_compression）
"""
import bpy, bmesh, math, os, heapq
import numpy as np
from mathutils import Vector, Quaternion, Matrix

try:
    REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
except NameError:
    REPO = '/Users/michaelho/main/project/2026-10-20-side-hustle/goblin-game'
ASSET_DIR = os.environ.get('ELF_ASSET_DIR', os.path.join(os.path.dirname(REPO), 'assets', 'assets_豎琴精靈'))
SRC_ELF = 'Meshy_AI_Elf_Character_v2_Remeshed_30k_20261107_texture_remesh_tri.blend'
SRC_HARP = 'Meshy_AI_Elven_Harp_Remeshed_15k_20261107_texture_remesh_tri.blend'
OUT_GLB = os.path.join(REPO, 'public', 'models', 'elf')
OUT_BLEND = os.path.join(REPO, 'tools', 'blender', 'out')

HEIGHT = 1.75
Y_SHIFT = 0.06  # 讓腳踝 / 骨盆落在 y≈0（角色旋轉軸）
TEX_SIZE = 2048  # 遊戲鏡頭 6–9 m，2K 貼圖已足夠；原始 4K
LOD1_RATIO = 0.3

# ── T-pose 骨架標記點（正規化後的 Blender 座標，左側；右側鏡像）──
ARM_Y, ARM_Z = -0.015, 1.415
T = {
    'clav': (0.025, -0.04, 1.43),
    'shoulder': (0.135, ARM_Y, ARM_Z),
    'elbow': (0.300, ARM_Y, ARM_Z),
    'wrist': (0.445, ARM_Y, 1.412),
    'tip': (0.625, -0.02, 1.410),
    'hip': (0.075, -0.045, 0.93),
    'knee': (0.052, -0.012, 0.56),
    'ankle': (0.037, 0.000, 0.11),
    'toe': (0.045, -0.100, 0.02),
}
SPINE = [  # (y, z)：hips 頭 → spine → chest → neck → head → 頭頂
    (-0.030, 1.00), (-0.045, 1.15), (-0.050, 1.30), (-0.045, 1.47), (-0.035, 1.55), (-0.030, 1.75),
]
ARM_DROP = math.radians(60)  # 手臂從水平往下 60°（與垂直約 30°，留空間給袖子與胸部）
SLEEVE_RIGID = 0.05  # 袖子距離手臂軸這個深度以內：剛性跟隨手臂
SLEEVE_DIR = Vector((0.28, 0.50, -1.0)).normalized()  # A-pose 中袖子垂墜方向（往外、往後；待機時前臂前彎內收後正好垂直往下）
HAIR_PUSH = 0.085  # 臉側髮束往後（+Y）推，讓開放下的手臂

HAIR_CHAINS = [  # (名稱, x, [(y, z) × 4 節點])
    ('hair_SR', -0.19, [(0.06, 1.48), (0.08, 1.33), (0.09, 1.18), (0.09, 1.02)]),
    ('hair_R', -0.09, [(0.09, 1.50), (0.14, 1.35), (0.16, 1.20), (0.16, 1.04)]),
    ('hair_C', 0.0, [(0.10, 1.50), (0.15, 1.35), (0.17, 1.20), (0.17, 1.04)]),
    ('hair_L', 0.09, [(0.09, 1.50), (0.14, 1.35), (0.16, 1.20), (0.16, 1.04)]),
    ('hair_SL', 0.19, [(0.06, 1.48), (0.08, 1.33), (0.09, 1.18), (0.09, 1.02)]),
]
SKIRT_DIRS = [('F', 0), ('FL', 45), ('L', 90), ('BL', 135), ('B', 180), ('BR', -135), ('R', -90), ('FR', -45)]
SKIRT_Z = [0.98, 0.70, 0.40, 0.08]
SKIRT_C = Vector((0.0, -0.02))  # 裙擺放射中心（xy）


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def seg_param(p, a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    ab = b - a
    t = np.clip(((p - a) @ ab) / (ab @ ab), 0, 1)
    return np.linalg.norm(p - (a + t[:, None] * ab), axis=1), t


def mirror(v, s):
    return (s * v[0], v[1], v[2])


# ───────────────────────── 1. 載入 / 正規化 ─────────────────────────
def reset():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.armatures, bpy.data.actions, bpy.data.images):
        for b in list(coll):
            coll.remove(b)


def append_mesh(blend, name):
    path = os.path.join(ASSET_DIR, blend)
    with bpy.data.libraries.load(path, link=False) as (src, dst):
        dst.objects = [n for n in src.objects]
    ob = next(o for o in dst.objects if o and o.type == 'MESH')
    bpy.context.scene.collection.objects.link(ob)
    ob.name = name
    ob.data.name = name
    return ob


def load_elf():
    ob = append_mesh(SRC_ELF, 'ElfMesh_LOD0')
    me = ob.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    s = HEIGHT / (co[:, 2].max() - co[:, 2].min())
    me.transform(Matrix.Translation((0, Y_SHIFT, -co[:, 2].min() * s)) @ Matrix.Scale(s, 4))
    me.update()
    return ob


def mesh_arrays(ob):
    me = ob.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    ev = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get('vertices', ev)
    return co.reshape(-1, 3), ev.reshape(-1, 2)


# ───────────────────────── 2. 測地線分區 ─────────────────────────
LABELS = ['HEAD', 'TORSO', 'ARM_L', 'ARM_R', 'SLEEVE_L', 'SLEEVE_R', 'LEG_L', 'LEG_R', 'HAIR', 'SKIRT']


def segment(co, edges):
    N = len(co)
    x, y, z = co.T
    ax = np.abs(x)
    seeds = {}
    for s, S in ((1, 'L'), (-1, 'R')):
        xs = x * s
        dfa, _ = seg_param(co, (s * 0.30, ARM_Y, ARM_Z), (s * 0.60, ARM_Y, ARM_Z))
        seeds['ARM_' + S] = (dfa < 0.035) & (xs > 0.33)
        seeds['SLEEVE_' + S] = ((xs > 0.32) & (xs < 0.55) & (z > 0.95) & (z < 1.30)) \
            | ((xs > 0.28) & (xs < 0.42) & (z > 0.74) & (z < 0.98))  # 袖子的綠色長尾
        dl, _ = seg_param(co, mirror(T['knee'], s), mirror(T['ankle'], s))
        dl2, _ = seg_param(co, mirror(T['hip'], s), mirror(T['knee'], s))
        seeds['LEG_' + S] = ((dl < 0.055) & (z > 0.15) & (z < 0.55)) | ((dl2 < 0.05) & (z > 0.6) & (z < 0.85) & (y < -0.04))
    seeds['HEAD'] = (z > 1.60) & (ax < 0.08) & (y < -0.08)
    seeds['HAIR'] = (y > 0.10) & (z > 1.15) & (z < 1.45)
    seeds['TORSO'] = (ax < 0.08) & (z > 1.1) & (z < 1.38) & (y < -0.07)
    seeds['SKIRT'] = ((z < 0.55) & (z > 0.12) & (ax > 0.16)) | ((z < 0.97) & (z > 0.5) & (y > 0.03) & (ax < 0.3)) \
        | ((z < 0.97) & (z > 0.5) & (ax > 0.14) & (ax < 0.22) & (y < 0.0))
    adj = build_adj(co, edges)
    lab = np.full(N, -1)
    dist = np.full(N, np.inf)
    h = []
    for i, k in enumerate(LABELS):
        for v in np.nonzero(seeds[k])[0]:
            if dist[v] > 0:
                dist[v] = 0.0
                lab[v] = i
                h.append((0.0, int(v), i))
    heapq.heapify(h)
    while h:
        d, v, i = heapq.heappop(h)
        if d > dist[v]:
            continue
        for w, l in adj[v]:
            nd = d + l
            if nd < dist[w]:
                dist[w] = nd
                lab[w] = i
                heapq.heappush(h, (nd, w, i))
    lab[lab < 0] = LABELS.index('TORSO')
    return lab, adj


# 分屬不同、且會各自運動的部位之間，Meshy 會把接觸處融合成「橋接面」（例如頭髮黏在手臂上、袖子黏在裙子上）。
# 這些面在動作中會被拉成長條，且權重平滑時會互相滲透，所以直接切開（接觸處本來就互相遮住）。
INCOMPATIBLE = [
    ('HAIR', 'ARM_L'), ('HAIR', 'ARM_R'), ('HAIR', 'SLEEVE_L'), ('HAIR', 'SLEEVE_R'), ('HAIR', 'SKIRT'),
    ('HEAD', 'ARM_L'), ('HEAD', 'ARM_R'), ('HEAD', 'SLEEVE_L'), ('HEAD', 'SLEEVE_R'),
    ('SLEEVE_L', 'SKIRT'), ('SLEEVE_R', 'SKIRT'), ('SLEEVE_L', 'TORSO'), ('SLEEVE_R', 'TORSO'),
    ('ARM_L', 'SKIRT'), ('ARM_R', 'SKIRT'), ('SLEEVE_L', 'LEG_L'), ('SLEEVE_R', 'LEG_R'),
    ('LEG_L', 'LEG_R'), ('HAIR', 'LEG_L'), ('HAIR', 'LEG_R'), ('HAIR', 'TORSO'),
]


def cut_bridges(ob, lab):
    bad = {(LABELS.index(a), LABELS.index(b)) for a, b in INCOMPATIBLE}
    bad |= {(b, a) for a, b in bad}
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    layer = bm.verts.layers.int.new('orig')
    for v in bm.verts:
        v[layer] = v.index
    kill = []
    for f in bm.faces:
        ls = {int(lab[v.index]) for v in f.verts}
        if any((a, b) in bad for a in ls for b in ls):
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.verts.ensure_lookup_table()
    orig = np.array([v[layer] for v in bm.verts])
    bm.verts.layers.int.remove(layer)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    print(f'cut {len(kill)} bridge faces')
    return lab[orig]


def build_adj(co, edges):
    adj = [[] for _ in range(len(co))]
    el = np.linalg.norm(co[edges[:, 0]] - co[edges[:, 1]], axis=1)
    for (a, b), d in zip(edges.tolist(), el.tolist()):
        adj[a].append((b, d))
        adj[b].append((a, d))
    return adj


# ───────────────────────── 3. 骨架定義（A-pose 最終位置）─────────────────────────
def rot_arm(s):
    """T-pose → A-pose 的手臂旋轉（繞通過肩關節、平行 Y 的軸）"""
    return Matrix.Rotation(s * ARM_DROP, 3, 'Y')


def arm_pt(p, s, k=1.0):
    S = Vector(mirror(T['shoulder'], s))
    return S + Matrix.Rotation(s * ARM_DROP * k, 3, 'Y') @ (Vector(p) - S)


def bone_table():
    """回傳 [(name, head, tail, parent, connect, deform)]，座標為 A-pose 最終 rest"""
    B = []
    sp = [Vector((0, yy, zz)) for yy, zz in SPINE]
    B.append(('root', (0, 0, 0), (0, 0.15, 0), None, False, True))
    for i, n in enumerate(['hips', 'spine', 'chest', 'neck', 'head']):
        B.append((n, sp[i], sp[i + 1], 'root' if i == 0 else ['hips', 'spine', 'chest', 'neck'][i - 1], i > 0, True))
    for s, S in ((1, 'L'), (-1, 'R')):
        sh, el, wr, tip = (arm_pt(mirror(T[k], s), s) for k in ('shoulder', 'elbow', 'wrist', 'tip'))
        B.append((f'shoulder.{S}', Vector(mirror(T['clav'], s)), sh, 'chest', False, True))
        B.append((f'upper_arm.{S}', sh, el, f'shoulder.{S}', True, True))
        B.append((f'forearm.{S}', el, wr, f'upper_arm.{S}', True, True))
        B.append((f'hand.{S}', wr, tip, f'forearm.{S}', True, True))
        # 袖子：從手肘下方沿垂墜方向兩節
        r0 = sh.lerp(el, 0.75) + Vector((0, 0.035, 0))  # 手肘後側（袖子掛在手臂後方）
        d = Vector((s * SLEEVE_DIR.x, SLEEVE_DIR.y, SLEEVE_DIR.z))
        B.append((f'sleeve.{S}', r0, r0 + d * 0.25, f'forearm.{S}', False, True))
        B.append((f'sleeve2.{S}', r0 + d * 0.25, r0 + d * 0.55, f'sleeve.{S}', True, True))
        hip, knee, ank, toe = (Vector(mirror(T[k], s)) for k in ('hip', 'knee', 'ankle', 'toe'))
        B.append((f'thigh.{S}', hip, knee, 'hips', False, True))
        B.append((f'shin.{S}', knee, ank, f'thigh.{S}', True, True))
        B.append((f'foot.{S}', ank, toe, f'shin.{S}', True, True))
    wr, tip = arm_pt(T['wrist'], 1), arm_pt(T['tip'], 1)
    mid = wr.lerp(tip, 0.45) + Vector((0, -0.03, 0))
    B.append(('prop_harp', mid, mid + Vector((0, -0.1, 0)), 'hand.L', False, False))
    for name, x, pts in HAIR_CHAINS:
        prev = 'head'
        for i in range(3):
            h = Vector((x, pts[i][0], pts[i][1]))
            t = Vector((x * (1 + 0.08 * (i + 1)), pts[i + 1][0], pts[i + 1][1]))
            if i == 0:
                h = Vector((x * 0.8, pts[0][0], pts[0][1]))
            B.append((f'{name}{i + 1}', h, t, prev, i > 0, True))
            prev = f'{name}{i + 1}'
    return B


def skirt_bones(co, lab):
    """依實際裙子形狀決定 8 條裙擺鏈的節點半徑"""
    sk = co[lab == LABELS.index('SKIRT')]
    rel = sk[:, :2] - np.array(SKIRT_C)
    ang = np.degrees(np.arctan2(rel[:, 0], -rel[:, 1]))  # 0 = 正前（-Y），90 = 左（+X）
    rad = np.linalg.norm(rel, axis=1)
    out = []
    for name, a in SKIRT_DIRS:
        da = np.abs((ang - a + 180) % 360 - 180)
        pts = []
        for zz in SKIRT_Z:
            m = (da < 30) & (np.abs(sk[:, 2] - zz) < 0.06)
            r = np.percentile(rad[m], 60) * 0.85 if m.sum() > 8 else (0.14 + (0.98 - zz) * 0.3)
            r = max(r, 0.12)
            ar = math.radians(a)
            pts.append(Vector((SKIRT_C[0] + math.sin(ar) * r, SKIRT_C[1] - math.cos(ar) * r, zz)))
        prev = 'hips'
        for i in range(3):
            out.append((f'skirt_{name}{i + 1}', pts[i], pts[i + 1], prev, i > 0, True))
            prev = f'skirt_{name}{i + 1}'
    return out


def build_rig(table):
    arm = bpy.data.armatures.new('ElfRig')
    rig = bpy.data.objects.new('ElfRig', arm)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    E = arm.edit_bones
    for name, h, t, parent, connect, deform in table:
        b = E.new(name)
        b.head, b.tail, b.use_deform = Vector(h), Vector(t), deform
        if parent:
            b.parent = E[parent]
            b.use_connect = connect
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig


# ───────────────────────── 4. 權重 ─────────────────────────
def chain_weights(p, nodes, names, W, base_w=None):
    """沿骨鏈（節點 nodes[0..n]）以投影參數做線性帽形混合"""
    n = len(names)
    # 以每個頂點到各段的距離最近者決定參數 t∈[0, n]
    best_d = np.full(len(p), np.inf)
    tt = np.zeros(len(p))
    for i in range(n):
        d, t = seg_param(p, nodes[i], nodes[i + 1])
        m = d < best_d
        best_d[m] = d[m]
        tt[m] = i + t[m]
    centers = np.arange(n) + 0.5
    for i, nm in enumerate(names):
        w = np.clip(1 - np.abs(tt - centers[i]), 0, 1)
        if i == 0:
            w[tt < centers[0]] = 1
        if i == n - 1:
            w[tt > centers[-1]] = 1
        W[nm] = W.get(nm, 0) + w * (1 if base_w is None else base_w)
    return tt


def compute_weights(co, lab, table):
    N = len(co)
    x, y, z = co.T
    W = {}
    L = {k: lab == i for i, k in enumerate(LABELS)}
    bones = {b[0]: b for b in table}

    def add(name, w, mask):
        a = W.setdefault(name, np.zeros(N))
        a[mask] += w[mask] if isinstance(w, np.ndarray) else w

    def spine_w(mask, k=1.0):
        zz = np.array([zz for _, zz in SPINE])
        names = ['hips', 'spine', 'chest', 'neck', 'head']
        c = (zz[:-1] + zz[1:]) / 2
        c[-1] = 1.58  # 頭骨權重從下巴開始
        for i, nm in enumerate(names):
            if i == 0:
                w = 1 - smoothstep(c[0], c[1], z)
            elif i == len(names) - 1:
                w = smoothstep(c[-2], c[-1], z)
            else:
                w = smoothstep(c[i - 1], c[i], z) * (1 - smoothstep(c[i], c[i + 1], z))
            add(nm, w * k, mask)

    # 軀幹與頭：沿脊椎；肩膀附近混入鎖骨 / 上臂
    body = L['HEAD'] | L['TORSO']
    for s, S in ((1, 'L'), (-1, 'R')):
        xs = x * s
        sh = smoothstep(0.07, 0.15, xs) * smoothstep(1.30, 1.38, z) * (1 - smoothstep(1.48, 1.53, z))
        sh *= L['TORSO'] * (1 - smoothstep(0.02, 0.06, y))
        upper = smoothstep(0.13, 0.18, xs) * sh
        add(f'shoulder.{S}', sh - upper, body & (xs > 0))
        add(f'upper_arm.{S}', upper, body & (xs > 0))
        W[f'_sh{S}'] = np.where(body & (xs > 0), sh, 0)
    rest = 1 - W.get('_shL', 0) - W.get('_shR', 0)
    spine_w(body, rest)

    # 手臂（T-pose 沿 x 軸）
    for s, S in ((1, 'L'), (-1, 'R')):
        m = L['ARM_' + S]
        xs = x * s
        u = xs
        sh_ = smoothstep(0.13, 0.19, u)
        el = smoothstep(T['elbow'][0] - 0.03, T['elbow'][0] + 0.03, u)
        wr = smoothstep(T['wrist'][0] - 0.015, T['wrist'][0] + 0.02, u)
        add(f'shoulder.{S}', 1 - sh_, m)
        add(f'upper_arm.{S}', sh_ * (1 - el), m)
        add(f'forearm.{S}', el * (1 - wr), m)
        add(f'hand.{S}', wr, m)

    # 袖子：上緣跟手臂，往下漸進交給袖子骨
    for s, S in ((1, 'L'), (-1, 'R')):
        m = L['SLEEVE_' + S]
        xs = x * s
        v = np.maximum(0, ARM_Z - z)
        ks = smoothstep(SLEEVE_RIGID * 0.6, SLEEVE_RIGID * 2.2, v)
        el = smoothstep(T['elbow'][0] - 0.04, T['elbow'][0] + 0.04, xs)
        add(f'upper_arm.{S}', (1 - ks) * (1 - el), m)
        add(f'forearm.{S}', (1 - ks) * el, m)
        k2 = smoothstep(0.22, 0.38, v)
        add(f'sleeve.{S}', ks * (1 - k2), m)
        add(f'sleeve2.{S}', ks * k2, m)

    # 腿
    for s, S in ((1, 'L'), (-1, 'R')):
        m = L['LEG_' + S]
        kn = smoothstep(T['knee'][2] - 0.05, T['knee'][2] + 0.05, z)
        an = smoothstep(T['ankle'][2] - 0.03, T['ankle'][2] + 0.03, z)
        hp = smoothstep(0.86, 0.97, z) * 0.6
        add('hips', hp, m)
        add(f'thigh.{S}', kn * (1 - hp), m)
        add(f'shin.{S}', (1 - kn) * an, m)
        add(f'foot.{S}', 1 - an, m)

    # 頭髮：x 方向在 5 條鏈之間線性混合；鏈內沿高度；頂端接頭骨
    m = L['HAIR']
    hx = np.array([c[1] for c in HAIR_CHAINS])
    xc = np.clip(x, hx[0], hx[-1])
    kh = 1 - smoothstep(1.43, 1.52, z)  # 1 = 頭髮鏈，0 = 頭骨
    add('head', 1 - kh, m)
    for i, (name, hx_i, pts) in enumerate(HAIR_CHAINS):
        if i == 0:
            wx = np.clip((hx[1] - xc) / (hx[1] - hx[0]), 0, 1)
        elif i == len(hx) - 1:
            wx = np.clip((xc - hx[-2]) / (hx[-1] - hx[-2]), 0, 1)
        else:
            wx = np.clip(1 - np.abs(xc - hx_i) / (hx[1] - hx[0]), 0, 1)
        zz = np.array([p[1] for p in pts])
        tt = np.interp(-z, -zz, np.arange(4))  # z 由上往下
        for j in range(3):
            w = np.clip(1 - np.abs(tt - (j + 0.5)), 0, 1)
            if j == 0:
                w[tt < 0.5] = 1
            if j == 2:
                w[tt > 2.5] = 1
            add(f'{name}{j + 1}', w * wx * kh, m)

    # 裙子：角度在相鄰兩條鏈之間混合、高度沿鏈；靠近腿的部分混入腿骨；頂端接骨盆
    m = L['SKIRT']
    rel = co[:, :2] - np.array(SKIRT_C)
    ang = np.degrees(np.arctan2(rel[:, 0], -rel[:, 1]))
    kt = 1 - smoothstep(0.90, 1.02, z)  # 1 = 裙擺鏈
    add('hips', 1 - kt, m)
    leg_k = np.zeros(N)
    for s, S in ((1, 'L'), (-1, 'R')):
        dl, t = seg_param(co, mirror(T['hip'], s), mirror(T['ankle'], s))
        k = (1 - smoothstep(0.05, 0.12, dl)) * 0.35
        W[f'_leg{S}'] = k
        leg_k = np.maximum(leg_k, k * smoothstep(T['knee'][2] - 0.25, T['knee'][2] + 0.1, z))
    for s, S in ((1, 'L'), (-1, 'R')):
        # 只混大腿：小腿在擺動期往後彎，若裙子跟著會被拖到地上
        k = W.pop(f'_leg{S}') * kt * smoothstep(T['knee'][2] - 0.25, T['knee'][2] + 0.1, z)
        add(f'thigh.{S}', k, m)
    ks = kt * (1 - leg_k)
    zz = np.array(SKIRT_Z)
    tt = np.interp(-z, -zz, np.arange(4))
    for i, (name, a) in enumerate(SKIRT_DIRS):
        da = np.abs((ang - a + 180) % 360 - 180)
        wa = np.clip(1 - da / 45, 0, 1)
        for j in range(3):
            w = np.clip(1 - np.abs(tt - (j + 0.5)), 0, 1)
            if j == 0:
                w[tt < 0.5] = 1
            if j == 2:
                w[tt > 2.5] = 1
            add(f'skirt_{name}{j + 1}', w * wa * ks, m)
    for k in [k for k in W if k.startswith('_')]:
        W.pop(k)
    return W


def smooth_weights(W, adj, iters=4, f=0.5):
    names = list(W)
    M = np.stack([W[n] for n in names], 1)
    N = len(adj)
    nb_i = np.concatenate([[i] * len(a) for i, a in enumerate(adj)]).astype(np.int64)
    nb_j = np.array([j for a in adj for j, _ in a], dtype=np.int64)
    deg = np.bincount(nb_i, minlength=N).astype(float)
    for _ in range(iters):
        acc = np.zeros_like(M)
        np.add.at(acc, nb_i, M[nb_j])
        avg = acc / np.maximum(deg, 1)[:, None]
        M = M * (1 - f) + avg * f
    return {n: M[:, i] for i, n in enumerate(names)}


def write_weights(ob, W, max_inf=4):
    names = list(W)
    M = np.stack([W[n] for n in names], 1)
    M[M < 1e-3] = 0
    idx = np.argsort(-M, axis=1)[:, :max_inf]
    top = np.take_along_axis(M, idx, 1)
    top /= np.maximum(top.sum(1, keepdims=True), 1e-9)
    for n in names:
        if n not in ob.vertex_groups:
            ob.vertex_groups.new(name=n)
    vg = [ob.vertex_groups[n] for n in names]
    for v in range(len(M)):
        for k in range(max_inf):
            w = float(top[v, k])
            if w > 1e-3:
                vg[idx[v, k]].add([v], w, 'REPLACE')


# ───────────────────────── 5. T-pose → A-pose ─────────────────────────
def repose(co, lab, W):
    L = {k: lab == i for i, k in enumerate(LABELS)}
    out = co.copy()
    x, y, z = co.T
    for s, S in ((1, 'L'), (-1, 'R')):
        Sh = np.array(mirror(T['shoulder'], s))
        # 手臂鏈的總權重 → 以角度混合旋轉（保持與肩關節的距離，肩膀不會塌陷）
        wa = sum(W.get(f'{b}.{S}', 0) for b in ('upper_arm', 'forearm', 'hand'))
        wa = np.clip(wa + W.get(f'sleeve.{S}', 0) + W.get(f'sleeve2.{S}', 0), 0, 1)
        side = (x * s > 0.02)
        for v in np.nonzero(side & (wa > 1e-3) & ~L['SLEEVE_' + S])[0]:
            R = Matrix.Rotation(s * ARM_DROP * wa[v], 3, 'Y')
            out[v] = Sh + np.array(R @ Vector(co[v] - Sh))
        # 袖子垂墜：p' = B(u) + R·(0, w, -min(v, r0)) + max(0, v - r0)·d
        R = rot_arm(s)
        d = np.array((s * SLEEVE_DIR.x, SLEEVE_DIR.y, SLEEVE_DIR.z))
        for v in np.nonzero(L['SLEEVE_' + S])[0]:
            p = co[v]
            u = p[0] * s - T['shoulder'][0]
            hv = max(0.0, ARM_Z - p[2])
            w = p[1] - ARM_Y
            base = Sh + np.array(R @ Vector((s * u, 0, 0)))
            out[v] = base + np.array(R @ Vector((0, w, -min(hv, SLEEVE_RIGID)))) + max(0.0, hv - SLEEVE_RIGID) * d
    # 臉側髮束：往後推到手臂後方（頭頂與髮尾漸弱）
    hair = L['HAIR'] | L['HEAD']
    k = smoothstep(0.08, 0.14, np.abs(x)) * smoothstep(0.92, 1.08, z) * (1 - smoothstep(1.43, 1.56, z))
    k *= 1 - smoothstep(0.10, 0.20, y)  # 已經在背後的頭髮不用動
    out[hair, 1] += (HAIR_PUSH * k)[hair]
    return out


# ───────────────────────── 6. 動作 ─────────────────────────
X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
FPS = 24
SINK = 0.006  # 腳底略陷入地面（草地遮住），避免看起來浮空
WALK_FRAMES, WALK_REF = 14, 1.9  # 走路一個循環 14 格（0.58 s），timeScale=1 時 1.9 m/s（步幅約 0.64 m）
RUN_FRAMES, RUN_REF = 12, 6.6  # 跑步一個循環 12 格（0.5 s），timeScale=1 時 6.6 m/s
Sn, Cs, TAU = math.sin, math.cos, 2 * math.pi


def build_actions(rig):
    sc = bpy.context.scene
    sc.render.fps, sc.render.fps_base = FPS, 1.0
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    keyed = [b.name for b in rig.data.bones if not b.name.startswith(('hair_', 'skirt_', 'sleeve', 'prop_'))]
    bones = rig.data.bones
    shL = bones['upper_arm.L'].head_local
    chest_front = -0.20  # 胸部最前緣 y（手要在這之前）

    def R(bname, *rots):
        Bm = bones[bname].matrix_local.to_3x3().inverted()
        q = Quaternion()
        for ax, deg in rots:
            q = Quaternion(Bm @ ax, math.radians(deg)) @ q
        return q

    def aim_chain(P, names, targets, k=1.0):
        bs = [bones[n] for n in names]
        parent_world = bs[0].parent.matrix_local.to_quaternion()
        parent_rest = bs[0].parent.matrix_local.to_quaternion()
        pos = bs[0].head_local.copy()
        for b, tgt in zip(bs, targets):
            rel = parent_rest.inverted() @ b.matrix_local.to_quaternion()
            base = parent_world @ rel
            d0 = base @ Vector((0, 1, 0))
            d1 = (Vector(tgt) - pos).normalized()
            world = d0.rotation_difference(d1) @ base
            q = base.inverted() @ world
            P[b.name].rotation_quaternion = Quaternion().slerp(q, k)
            world = base @ P[b.name].rotation_quaternion
            pos = pos + (world @ Vector((0, 1, 0))) * b.length
            parent_world, parent_rest = world, b.matrix_local.to_quaternion()

    # ── 腳底接地 ──
    # 腳底接觸點（腳跟、腳尖），以 foot 骨區域座標儲存，姿勢後可求世界高度
    soles = {}
    for S in ('L', 'R'):
        fb = bones[f'foot.{S}']
        ank, toe = fb.head_local, fb.tail_local
        inv = fb.matrix_local.inverted()
        soles[S] = [inv @ Vector((ank.x, ank.y + 0.035, 0.0)), inv @ Vector((toe.x, toe.y - 0.01, 0.0))]

    def lowest_sole(P):
        bpy.context.view_layer.update()
        return min((P[f'foot.{S}'].matrix @ p).z for S in ('L', 'R') for p in soles[S])

    def make(name, length, fn, step, ground='plant'):
        """ground: 'plant' = 每格把最低的腳底貼到地面（略陷入草地）；'hop' = 同上但保留 fn 設定的跳躍高度；None = fn 自己處理"""
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        rig.animation_data_create()
        rig.animation_data.action = act
        for f in range(0, length + 1, step):
            for pb in rig.pose.bones:
                pb.rotation_quaternion = Quaternion()
                pb.location = Vector()
            P = rig.pose.bones
            fn(f / length, P, R)
            if ground:
                hop = P['root'].location.z if ground == 'hop' else 0.0
                P['root'].location.z = 0.0 if ground == 'hop' else P['root'].location.z
                P['root'].location.z += -lowest_sole(P) - SINK + hop
            for n in keyed:
                P[n].keyframe_insert('rotation_quaternion', frame=f)
            P['root'].keyframe_insert('location', frame=f)
        return act

    def aim(pb, target):
        """把骨頭（armature 空間）轉向目標點，保留扭轉（最小旋轉）"""
        bpy.context.view_layer.update()
        M = pb.matrix.copy()
        head = M.translation.copy()
        d0 = (M.to_3x3() @ Vector((0, 1, 0))).normalized()
        d1 = (Vector(target) - head).normalized()
        Rm = d0.rotation_difference(d1).to_matrix()
        pb.matrix = Matrix.Translation(head) @ (Rm @ M.to_3x3()).to_4x4()
        bpy.context.view_layer.update()

    def gait_ik(frames, speed, stance, lift, lean, arm_amp, twist, sway, flight=0.0, dip=0.012):
        """IK 步態：支撐腳鎖在地面、以 speed（m/s，動作 timeScale=1 時）往後移動 → 遊戲中不滑步。
        骨盆高度 = 支撐腳伸直（留一點彎曲）能碰到地面的最高位置，所以永遠不會浮空；
        騰空期（跑步兩腳都離地）在前後支撐之間內插並加上小跳。"""
        cyc = frames / FPS
        D = speed * stance * cyc  # 一隻腳在支撐期內相對骨盆往後移的距離
        th = {S: bones[f'thigh.{S}'] for S in ('L', 'R')}
        La = {S: th[S].length for S in th}
        Lb = {S: bones[f'shin.{S}'].length for S in th}
        hip0 = {S: th[S].head_local.copy() for S in th}
        ank0 = {S: bones[f'foot.{S}'].head_local.copy() for S in th}

        def foot(S, t):
            p = (t + (0.0 if S == 'L' else 0.5)) % 1.0
            a = ank0[S]
            if p < stance:
                fwd, h, q = D / 2 - p / stance * D, 0.0, None
            else:
                q = (p - stance) / (1 - stance)
                e = (1 - math.cos(math.pi * q)) / 2
                fwd, h = -D / 2 + e * D, lift * math.sin(math.pi * q) ** 0.9
            # 前進方向 = -Y；兩腳略往中線收，步態較女性化
            return Vector((a.x * 0.8, a.y - fwd, a.z + h)), q

        # 第一遍：每格骨盆可下降量（取支撐腳的限制），騰空格內插
        N = 64
        dz = []
        for i in range(N):
            t = i / N
            lim = []
            for S in ('L', 'R'):
                tgt, q = foot(S, t)
                if q is None:
                    hp = hip0[S]
                    hd = math.hypot(tgt.x - hp.x, tgt.y - hp.y)
                    reach = (La[S] + Lb[S]) * 0.985
                    lim.append(tgt.z + math.sqrt(max(reach * reach - hd * hd, 0.0)) - hp.z)
            dz.append(min(lim) - dip if lim else None)
        for i in range(N):
            if dz[i] is None:
                j0 = next(k for k in range(1, N) if dz[(i - k) % N] is not None)
                j1 = next(k for k in range(1, N) if dz[(i + k) % N] is not None)
                a0, a1 = dz[(i - j0) % N], dz[(i + j1) % N]
                u = j0 / (j0 + j1)
                dz[i] = a0 + (a1 - a0) * u + flight * math.sin(math.pi * u)

        def f(t, P, R):
            a, b = Sn(t * TAU), Sn(t * TAU + math.pi)
            # 上半身：骨盆左右扭轉跟著跨步、軀幹反向扭、手臂與對側腳同步前後擺
            P['hips'].rotation_quaternion = R('hips', (Z, twist * a), (Y, sway * Cs(t * TAU)), (X, lean * 0.3))
            P['spine'].rotation_quaternion = R('spine', (Z, -twist * 0.6 * a), (X, lean * 0.4))
            P['chest'].rotation_quaternion = R('chest', (Z, -twist * 0.5 * a), (Y, -sway * 0.6 * Cs(t * TAU)), (X, lean * 0.3))
            P['head'].rotation_quaternion = R('head', (Z, twist * 0.4 * a), (X, -lean * 0.6))
            P['upper_arm.L'].rotation_quaternion = R('upper_arm.L', (Y, IN - 3), (X, arm_amp * b))
            P['upper_arm.R'].rotation_quaternion = R('upper_arm.R', (Y, -IN + 3), (X, arm_amp * a))
            P['forearm.L'].rotation_quaternion = R('forearm.L', (X, -18 - arm_amp * 0.7 * max(0, -b)))
            P['forearm.R'].rotation_quaternion = R('forearm.R', (X, -18 - arm_amp * 0.7 * max(0, -a)))
            P['hand.L'].rotation_quaternion = R('hand.L', (Y, 6))
            P['hand.R'].rotation_quaternion = R('hand.R', (Y, -6))
            # 骨盆高度（查表內插）與左右重心轉移
            x = t * N
            i0 = int(x) % N
            z = dz[i0] + (dz[(i0 + 1) % N] - dz[i0]) * (x - int(x))
            P['root'].location = Vector((0.008 * sway * Cs(t * TAU), 0, z - SINK))
            # 腿：兩骨 IK，膝蓋朝前
            for S in ('L', 'R'):
                tgt, q = foot(S, t)
                tgt.z -= SINK
                bpy.context.view_layer.update()
                hip = P[f'thigh.{S}'].head.copy()
                d = tgt - hip
                dist = min(d.length, (La[S] + Lb[S]) * 0.999)
                dn = d.normalized()
                ca = max(-1.0, min(1.0, (La[S] ** 2 + dist ** 2 - Lb[S] ** 2) / (2 * La[S] * dist)))
                pole = Vector((0, -1, 0))
                pole = (pole - dn * pole.dot(dn)).normalized()
                knee = hip + dn * La[S] * ca + pole * La[S] * math.sqrt(1 - ca * ca)
                aim(P[f'thigh.{S}'], knee)
                aim(P[f'shin.{S}'], hip + dn * dist)
                # 腳掌：支撐期保持 rest 的世界方向（高跟鞋腳底貼地），擺動期腳尖略下垂
                pb = P[f'foot.{S}']
                rest3 = bones[f'foot.{S}'].matrix_local.to_3x3()
                pitch = Matrix.Rotation(math.radians(-18 * math.sin(math.pi * q)) if q is not None else 0.0, 3, 'X')
                bpy.context.view_layer.update()
                pb.matrix = Matrix.Translation(pb.head) @ (pitch @ rest3).to_4x4()
                bpy.context.view_layer.update()
        return f

    # rest 是手臂與垂直約 30° 的 A-pose；自然站姿再往內收約 12°
    IN = 8

    def idle(t, P, R):
        b = Sn(t * TAU)
        P['upper_arm.L'].rotation_quaternion = R('upper_arm.L', (Y, IN + 1.5 * b), (X, -6))
        P['upper_arm.R'].rotation_quaternion = R('upper_arm.R', (Y, -IN - 1.5 * b), (X, -6))
        P['forearm.L'].rotation_quaternion = R('forearm.L', (X, -14), (Y, 4))
        P['forearm.R'].rotation_quaternion = R('forearm.R', (X, -14), (Y, -4))
        P['hand.L'].rotation_quaternion = R('hand.L', (Y, 8))
        P['hand.R'].rotation_quaternion = R('hand.R', (Y, -8))
        P['chest'].rotation_quaternion = R('chest', (X, 1.5 * b))
        P['spine'].rotation_quaternion = R('spine', (X, 0.8 * Sn(t * TAU + 0.6)))
        P['hips'].rotation_quaternion = R('hips', (Y, 1.5 * b), (Z, 3 * b))
        P['neck'].rotation_quaternion = R('neck', (Z, 2 * b))
        P['head'].rotation_quaternion = R('head', (Y, 3 * Sn(t * TAU + 1)), (Z, 4 * b), (X, 3))
        P['root'].location = Vector((0, 0, -0.004 * (1 + Sn(t * TAU * 2))))

    def play(t, P, R):
        # 彈豎琴：左手在胸前左下扶琴，右手在琴弦上撥（手在胸部前方）
        w = Sn(t * TAU * 4)
        cz = 1.24
        aim_chain(P, ['upper_arm.L', 'forearm.L', 'hand.L'],
                  [(0.20, -0.08, 1.27), (0.10, chest_front - 0.07, 1.20), (0.05, chest_front - 0.12, 1.21)])
        aim_chain(P, ['upper_arm.R', 'forearm.R', 'hand.R'],
                  [(-0.20, -0.08, 1.27 + 0.008 * w), (-0.06, chest_front - 0.08 + 0.01 * w, cz + 0.02 * w),
                   (-0.02, chest_front - 0.12, cz + 0.025 * Sn(t * TAU * 4 + 0.8))])
        P['head'].rotation_quaternion = R('head', (X, 12), (Z, 8 * Sn(t * TAU)), (Y, 5 * Sn(t * TAU)))
        P['chest'].rotation_quaternion = R('chest', (Z, 3 * Sn(t * TAU)), (X, 3))
        P['hips'].rotation_quaternion = R('hips', (Y, 2 * Sn(t * TAU)))

    def cast(t, P, R):
        # 魔法凝視：雙手在臉前比愛心
        k = min(1, t * 3)
        k = k * k * (3 - 2 * k)
        for s_, S_ in ((1, 'L'), (-1, 'R')):
            aim_chain(P, [f'upper_arm.{S_}', f'forearm.{S_}', f'hand.{S_}'],
                      [(s_ * 0.20, -0.11, 1.30), (s_ * 0.045, -0.24, 1.48), (s_ * 0.004, -0.255, 1.56)], k)
        P['head'].rotation_quaternion = R('head', (Z, 10 * k), (X, -4 * k))

    def strike(t, P, R):
        k = Sn(min(1, t * 1.6) * math.pi * 0.5)
        P['upper_arm.R'].rotation_quaternion = R('upper_arm.R', (Y, -10 - 30 * k), (X, -90 * k))
        P['forearm.R'].rotation_quaternion = R('forearm.R', (X, -10))
        P['hand.R'].rotation_quaternion = R('hand.R', (X, -50 * k))
        P['upper_arm.L'].rotation_quaternion = R('upper_arm.L', (Y, IN + 4), (X, 25 * k))
        P['spine'].rotation_quaternion = R('spine', (Z, -14 * k))
        P['chest'].rotation_quaternion = R('chest', (Z, -10 * k), (X, 6 * k))

    def capture(t, P, R):
        k = Sn(t * TAU * 2)
        P['spine'].rotation_quaternion = R('spine', (X, 14))
        P['chest'].rotation_quaternion = R('chest', (X, 10))
        P['head'].rotation_quaternion = R('head', (X, 14))
        P['upper_arm.L'].rotation_quaternion = R('upper_arm.L', (Y, 30), (X, -62 + 18 * k))
        P['upper_arm.R'].rotation_quaternion = R('upper_arm.R', (Y, -30), (X, -62 - 18 * k))
        P['forearm.L'].rotation_quaternion = R('forearm.L', (X, -40 - 15 * k))
        P['forearm.R'].rotation_quaternion = R('forearm.R', (X, -40 + 15 * k))
        for s in ('L', 'R'):
            P[f'thigh.{s}'].rotation_quaternion = R(f'thigh.{s}', (X, -12))
            P[f'shin.{s}'].rotation_quaternion = R(f'shin.{s}', (X, 20))
        P['root'].location = Vector((0, 0, -0.04))

    def victory(t, P, R):
        hop = max(0, Sn(t * TAU))
        P['upper_arm.L'].rotation_quaternion = R('upper_arm.L', (Y, -110 - 15 * hop), (X, -20))
        P['upper_arm.R'].rotation_quaternion = R('upper_arm.R', (Y, 110 + 15 * hop), (X, -20))
        P['forearm.L'].rotation_quaternion = R('forearm.L', (X, -25))
        P['forearm.R'].rotation_quaternion = R('forearm.R', (X, -25))
        P['head'].rotation_quaternion = R('head', (X, -14), (Z, 8 * Sn(t * TAU)))
        P['chest'].rotation_quaternion = R('chest', (X, -6))
        for s in ('L', 'R'):
            P[f'shin.{s}'].rotation_quaternion = R(f'shin.{s}', (X, 30 * hop))
        P['root'].location = Vector((0, 0, 0.12 * hop))

    def stunned(t, P, R):
        P['upper_arm.L'].rotation_quaternion = R('upper_arm.L', (Y, -15), (X, -15))
        P['upper_arm.R'].rotation_quaternion = R('upper_arm.R', (Y, 15), (X, -15))
        P['forearm.L'].rotation_quaternion = R('forearm.L', (X, -30))
        P['forearm.R'].rotation_quaternion = R('forearm.R', (X, -30))
        P['head'].rotation_quaternion = R('head', (Z, 16 * Sn(t * TAU)), (X, 8))
        P['spine'].rotation_quaternion = R('spine', (Z, 6 * Sn(t * TAU + 0.5)))
        P['hips'].rotation_quaternion = R('hips', (Z, 4 * Sn(t * TAU + 1)))

    make('Idle', 60, idle, 5)
    # 步態的參考速度要和 ElfAnimState 的 WALK_REF / RUN_REF 一致（遊戲依實際速度調整播放速率）
    make('Walk', WALK_FRAMES, gait_ik(WALK_FRAMES, WALK_REF, 0.58, 0.065, 4, 14, 6, 3), 1, ground=None)
    make('Run', RUN_FRAMES, gait_ik(RUN_FRAMES, RUN_REF, 0.34, 0.16, 14, 34, 9, 4, flight=0.035, dip=0.03), 1, ground=None)
    make('Play', 40, play, 2)
    make('Cast', 24, cast, 2)
    make('Strike', 14, strike, 1)
    make('Capture', 16, capture, 2)
    make('Victory', 48, victory, 3, ground='hop')
    make('Stunned', 30, stunned, 3)
    rig.animation_data.action = bpy.data.actions['Idle']
    for pb in rig.pose.bones:
        pb.rotation_quaternion = Quaternion()
        pb.location = Vector()


# ───────────────────────── 7. 材質 / 貼圖 ─────────────────────────
def prep_material(ob, mat_name, img_prefix, size):
    mat = ob.data.materials[0]
    mat.name = mat_name
    for n in mat.node_tree.nodes:
        if n.type == 'TEX_IMAGE' and n.image:
            img = n.image
            is_mr = 'metallic' in img.name or 'rough' in img.name
            img.name = f'{img_prefix}_orm' if is_mr else f'{img_prefix}_color'
            target = size // 2 if is_mr else size
            if img.size[0] > target:
                img.scale(target, target)
    bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    return mat, bsdf


# ───────────────────────── 8. 豎琴 ─────────────────────────
HARP_HEIGHT = 0.55


def load_harp():
    h = append_mesh(SRC_HARP, 'Harp')
    me = h.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    s = HARP_HEIGHT / (co[:, 2].max() - co[:, 2].min())
    me.transform(Matrix.Scale(s, 4))
    co *= s
    # 握把：前柱（-X 側的直柱）中段
    zmid = (co[:, 2].min() + co[:, 2].max()) / 2
    band = co[np.abs(co[:, 2] - (zmid - 0.02)) < 0.02]
    left = band[band[:, 0] < np.percentile(band[:, 0], 12)]
    grip = Vector((left[:, 0].mean(), left[:, 1].mean(), zmid - 0.02))
    me.transform(Matrix.Translation(-grip))
    me.update()
    prep_material(h, 'M_HarpWood', 'harp', 1024)
    return h


# ───────────────────────── 9. 組裝 / 匯出 ─────────────────────────
def set_coords(ob, co):
    ob.data.vertices.foreach_set('co', co.reshape(-1))
    ob.data.update()


def make_lod1(lod0):
    bpy.ops.object.select_all(action='DESELECT')
    lod0.select_set(True)
    bpy.context.view_layer.objects.active = lod0
    bpy.ops.object.duplicate()
    lod1 = bpy.context.active_object
    lod1.name = lod1.data.name = 'ElfMesh_LOD1'
    for m in list(lod1.modifiers):
        lod1.modifiers.remove(m)
    dec = lod1.modifiers.new('Dec', 'DECIMATE')
    dec.ratio = LOD1_RATIO
    bpy.ops.object.modifier_apply(modifier='Dec')
    lod1.data.validate()
    # 減面會內插權重，可能超過 4 個影響：重新正規化成最多 4 個
    W = {vg.name: np.zeros(len(lod1.data.vertices)) for vg in lod1.vertex_groups}
    names = [vg.name for vg in lod1.vertex_groups]
    for v in lod1.data.vertices:
        for g in v.groups:
            W[names[g.group]][v.index] = g.weight
    for vg in list(lod1.vertex_groups):
        lod1.vertex_groups.remove(vg)
    write_weights(lod1, W)
    return lod1


def bind(ob, rig):
    ob.parent = rig
    mod = ob.modifiers.new('Armature', 'ARMATURE')
    mod.object = rig


def export(rig, meshes, harp):
    os.makedirs(OUT_GLB, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for o in [rig] + meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUT_GLB, 'elf.glb'), export_format='GLB', use_selection=True,
        export_animations=True, export_animation_mode='ACTIONS', export_skins=True,
        export_apply=False, export_yup=True, export_texcoords=True, export_normals=True,
        export_image_format='WEBP', export_image_quality=90, export_def_bones=False, export_force_sampling=True,
        export_optimize_animation_size=True, export_meshopt_compression_enable=True,
    )
    bpy.ops.object.select_all(action='DESELECT')
    harp.select_set(True)
    bpy.context.view_layer.objects.active = harp
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT_GLB, 'harp.glb'), export_format='GLB', use_selection=True,
                              export_animations=False, export_yup=True, export_image_format='WEBP',
                              export_image_quality=90, export_meshopt_compression_enable=True)
    print('exported to', OUT_GLB)


def main(do_export=True):
    reset()
    ob = load_elf()
    co, edges = mesh_arrays(ob)
    lab, _ = segment(co, edges)
    lab = cut_bridges(ob, lab)
    co, edges = mesh_arrays(ob)
    adj = build_adj(co, edges)
    table = bone_table()
    table += skirt_bones(co, lab)
    W = compute_weights(co, lab, table)
    W = smooth_weights(W, adj)
    co_a = repose(co, lab, W)
    set_coords(ob, co_a)
    # 分區存成頂點色（除錯用，匯出時不輸出）
    ca = ob.data.color_attributes.new('seg_debug', 'FLOAT_COLOR', 'POINT')
    pal = [(1, 0, 1), (.5, 0, .5), (1, 0, 0), (0, .6, 1), (1, .5, 0), (0, 1, 0), (0, 0, 1), (.4, .8, .2), (1, 1, 0), (1, 1, 1)]
    ca.data.foreach_set('color', np.array([(*pal[l], 1.0) for l in lab]).reshape(-1))
    rig = build_rig(table)
    write_weights(ob, W)
    mat, bsdf = prep_material(ob, 'M_Elf', 'elf', TEX_SIZE)
    bind(ob, rig)
    lod1 = make_lod1(ob)
    bind(lod1, rig)
    build_actions(rig)
    harp = load_harp()
    harp.location = (0.9, 0, 1.0)
    os.makedirs(OUT_BLEND, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_BLEND, 'elf_meshy.blend'))
    if do_export:
        ob.data.color_attributes.remove(ob.data.color_attributes['seg_debug'])
        if 'seg_debug' in lod1.data.color_attributes:
            lod1.data.color_attributes.remove(lod1.data.color_attributes['seg_debug'])
        harp.location = (0, 0, 0)
        export(rig, [ob, lod1], harp)
        harp.location = (0.9, 0, 1.0)
    return rig, ob, lod1, harp


if __name__ == '__main__' or __name__ == '<run_path>' or __name__ == 'builtins':
    main(do_export=os.environ.get('ELF_NO_EXPORT') != '1')
