"""
Catch Goblin — 女精靈（豎琴手）程序化建模 / 綁骨 / 動畫 / 匯出腳本

⚠️ 這是「暫時預覽版」(TEMPORARY PREVIEW) 角色：
   以 Python 程序化產生的造型，用來驗證 GLB 管線、骨架、動畫與遊戲整合。
   它「不等於」參考圖的品質，正式美術需依 docs/elf-asset-spec.md 由美術重新建模、雕刻、手繪貼圖。

用法（在 Blender 5.x 內）：
    exec(open('<repo>/tools/blender/build_elf.py').read())
或命令列：
    blender -b -P tools/blender/build_elf.py

輸出：
    public/models/elf/elf.glb    角色（LOD0 + LOD1 兩組 SkinnedMesh 共用骨架 + 9 個動作）
    public/models/elf/harp.glb   豎琴道具（原點 = 握把，供掛到 prop_harp 骨頭）
    tools/blender/out/elf.blend  可編輯的原始檔
"""
import bpy, bmesh, math, os, random
import numpy as np
from mathutils import Vector, Quaternion, Matrix
from mathutils.geometry import intersect_point_line
from mathutils.bvhtree import BVHTree

try:
    REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
except NameError:
    REPO = '/Users/michaelho/main/project/2026-10-20-side-hustle/goblin-game'
OUT_GLB = os.path.join(REPO, 'public', 'models', 'elf')
OUT_BLEND = os.path.join(REPO, 'tools', 'blender', 'out')

HC = Vector((0, -0.005, 1.598))  # 頭部中心（下巴約 1.477，脖子只露出約 1/3 頭高）

# 骨架比例（動漫美型 7.2 頭身，頭高 H≈0.24 m，頭頂 1.735 m）。左側座標，右側鏡像。
#   下巴 1H(1.49) → 肩線 1.39（脖子只露出約 0.35H）→ 胸線 2H(1.26) → 腰 2.75H(1.075)
#   → 跨下約身高一半(0.85) → 膝 5.3H(0.475) → 腳踝 0.08
#   手肘對齊腰、手腕對齊跨下、指尖到大腿中段；肩寬與臀寬接近
SK = {
    'shoulder': (0.140, 0.012, 1.402),
    'elbow': (0.232, 0.025, 1.110),
    'wrist': (0.300, 0.010, 0.885),
    'hand_tip': (0.330, 0.000, 0.790),
    'hip': (0.086, 0.000, 0.885),
    'knee': (0.088, 0.002, 0.475),
    'ankle': (0.088, 0.022, 0.080),
    'toe': (0.094, -0.090, 0.020),
    'pelvis_z': 0.93,
    'waist_z': 1.075,
    'chest_z': 1.24,
    'neck_z': 1.40,
    'head_z': 1.475,
}


def skv(name, side=1, dx=0.0, dy=0.0, dz=0.0):
    x, y, z = SK[name]
    return Vector((side * (x + dx), y + dy, z + dz))
GOLD = (0.86, 0.68, 0.30)


# ───────────────────────── 工具 ─────────────────────────
def scene():
    return bpy.context.scene


def link(ob):
    scene().collection.objects.link(ob)
    return ob


def reset():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.armatures, bpy.data.curves, bpy.data.actions, bpy.data.images):
        for b in list(coll):
            coll.remove(b)


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def pbr(name, col,rough=0.5, metal=0.0, alpha=1.0, emis=None, img=None):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bs = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    # 顏色以 sRGB 指定（與貼圖一致），節點輸入為線性值
    col = tuple(srgb_to_linear(c) for c in col)
    bs.inputs['Base Color'].default_value = (*col, 1)
    bs.inputs['Roughness'].default_value = rough
    bs.inputs['Metallic'].default_value = metal
    if img:
        t = m.node_tree.nodes.new('ShaderNodeTexImage')
        t.image = img
        m.node_tree.links.new(t.outputs['Color'], bs.inputs['Base Color'])
    if alpha < 1:
        bs.inputs['Alpha'].default_value = alpha
        try:
            m.surface_render_method = 'BLENDED'
        except Exception:
            pass
    if emis:
        bs.inputs['Emission Color'].default_value = (*(srgb_to_linear(c) for c in emis[0]), 1)
        bs.inputs['Emission Strength'].default_value = emis[1]
    return m


def make_img(name, arr):
    h, w = arr.shape[:2]
    im = bpy.data.images.new(name, w, h, alpha=False)
    im.pixels.foreach_set(np.clip(arr, 0, 1).astype(np.float32).ravel())
    im.pack()
    return im


def sweep(name, pts, rw, rd, seg=8, cap=True, ups=None):
    """沿折線掃出橢圓斷面的管狀網格（髮束、耳朵、滾邊、葉片）。rw=寬半徑, rd=厚半徑, ups=寬方向"""
    n = len(pts)
    verts, faces = [], []
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
        side = ups[i] if ups else Vector((1, 0, 0))
        side = (side - t * side.dot(t)).normalized()
        nrm = t.cross(side).normalized()
        for j in range(seg):
            a = 2 * math.pi * j / seg
            verts.append(p + side * math.cos(a) * rw[i] + nrm * math.sin(a) * rd[i])
    for i in range(n - 1):
        for j in range(seg):
            a = i * seg + j
            b = i * seg + (j + 1) % seg
            faces.append((a, b, b + seg, a + seg))
    if cap:
        verts.append(pts[-1] + (pts[-1] - pts[-2]).normalized() * 0.002)
        tip = len(verts) - 1
        for j in range(seg):
            faces.append(((n - 1) * seg + j, (n - 1) * seg + (j + 1) % seg, tip))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    uv = me.uv_layers.new(name='UVMap')
    for p in me.polygons:
        p.use_smooth = True
        for li in p.loop_indices:
            vi = me.loops[li].vertex_index
            if vi >= n * seg:
                uv.data[li].uv = (0.5, 0.0)
            else:
                i, j = divmod(vi, seg)
                uv.data[li].uv = (j / seg, 1 - i / (n - 1))
    return link(bpy.data.objects.new(name, me))


def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    o.data.name = name
    return o


def apply_mods(o):
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    for m in list(o.modifiers):
        if m.type != 'ARMATURE':
            bpy.ops.object.modifier_apply(modifier=m.name)


def solidify(o, th, offset=-1.0):
    s = o.modifiers.new('Sol', 'SOLIDIFY')
    s.thickness = th
    s.offset = offset
    apply_mods(o)


def bez(ps, n):
    out = []
    for i in range(n):
        t = i / (n - 1)
        q = [Vector(p) for p in ps]
        while len(q) > 1:
            q = [q[k].lerp(q[k + 1], t) for k in range(len(q) - 1)]
        out.append(q[0])
    return out


def lathe(name, z_top, z_bot, prof, rings=18, seg=64, a0=0.0, a1=2 * math.pi, wave=0.0, nw=10):
    """旋轉面（裙子）。a=0 為正面 (-Y)。接縫不閉合，避免 UV 接縫拉扯。"""
    verts, uvs, faces = [], [], []
    cols = seg + 1
    for i in range(rings):
        t = i / (rings - 1)
        z = z_top + (z_bot - z_top) * t
        for j in range(cols):
            a = a0 + (a1 - a0) * j / seg
            rx, ry = prof(t, a)
            w = wave * t ** 2 * math.sin(a * nw)
            zz = z + (0.4 * t * math.cos(a * nw * 2) * wave if wave else 0)
            verts.append((math.sin(a) * (rx + w), -math.cos(a) * (ry + w), zz))
            uvs.append((j / seg, 1 - t))
    for i in range(rings - 1):
        for j in range(seg):
            faces.append((i * cols + j, i * cols + j + 1, (i + 1) * cols + j + 1, (i + 1) * cols + j))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    uvl = me.uv_layers.new(name='UVMap')
    for p in me.polygons:
        p.use_smooth = True
        for li in p.loop_indices:
            uvl.data[li].uv = uvs[me.loops[li].vertex_index]
    if abs((a1 - a0) - 2 * math.pi) < 1e-6:
        # 完整一圈：合併接縫頂點（UV 存在 loop 上不受影響），否則 Solidify 會把接縫的兩條開口邊推開、穿出外層
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        bm.to_mesh(me)
        bm.free()
    return link(bpy.data.objects.new(name, me))


# ───────────────────────── 貼圖 ─────────────────────────
def face_texture():
    W = 1024
    v, u = np.mgrid[0:W, 0:W].astype(np.float32) / W
    img = np.ones((W, W, 4), np.float32)
    img[..., :3] = (0.99, 0.86, 0.78)

    def blend(mask, col, a=1.0):
        m = np.clip(mask, 0, 1)[..., None] * a
        img[..., :3] = img[..., :3] * (1 - m) + np.array(col) * m

    def aa(d, w=0.003):
        return np.clip(0.5 - d / w, 0, 1)

    def ell(cx, cy, rx, ry):
        return (np.sqrt(((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2) - 1) * min(rx, ry)

    def ring(cx, cy, rx, ry, th):
        return np.abs(np.sqrt(((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2) - 1) * min(rx, ry) - th

    for s in (-1, 1):
        d = np.sqrt(((u - (0.5 + s * 0.235)) / 0.08) ** 2 + ((v - 0.335) / 0.035) ** 2)
        blend(np.exp(-d * d * 1.5), (1.0, 0.6, 0.62), 0.5)
    EY, E = 0.425, 1.5
    LASH = (0.20, 0.11, 0.07)
    for s in (-1, 1):
        ex = 0.5 + s * 0.2
        rx, ry = 0.072 * E, 0.06 * E
        scl = ell(ex, EY, rx, ry)
        blend(aa(scl), (1, 0.985, 0.97))
        icx = ex - s * 0.006
        irx, iry = 0.05 * E, 0.062 * E
        ir = ell(icx, EY - 0.006, irx, iry)
        t = np.clip((v - (EY - iry)) / (2 * iry), 0, 1)
        col = np.stack([0.06 + 0.10 * t, 0.42 - 0.22 * t, 0.22 - 0.08 * t], -1)
        cov = (aa(ir) * aa(scl))[..., None]
        img[..., :3] = img[..., :3] * (1 - cov) + col * cov
        blend(aa(ring(icx, EY - 0.006, irx, iry, 0.004)) * aa(scl), (0.03, 0.14, 0.08), 0.9)
        blend(aa(ell(icx, EY - 0.002, 0.021 * E, 0.03 * E)) * aa(scl), (0.02, 0.09, 0.05))
        blend(aa(ell(icx, EY - 0.045 * E, 0.032 * E, 0.016 * E)) * aa(ir) * aa(scl), (0.45, 0.92, 0.55), 0.55)
        blend(aa(ell(icx - 0.018 * E, EY + 0.022 * E, 0.016 * E, 0.02 * E)), (1, 1, 1))
        blend(aa(ell(icx + 0.02 * E, EY - 0.03 * E, 0.007 * E, 0.008 * E)), (1, 1, 1), 0.9)
        blend(aa(ring(ex, EY - 0.004, rx * 1.04, ry * 1.06, 0.0065 * E)) * (v > EY + ry * 0.25), LASH)
        blend(aa(ell(ex + s * rx * 0.98, EY + ry * 0.55, 0.024 * E, 0.008 * E)), LASH)
        blend(aa(ring(ex, EY + 0.006, rx * 1.05, ry * 1.25, 0.0014)) * (v > EY + ry * 0.95) * (np.abs(u - ex) < rx * 0.7), (0.75, 0.5, 0.42), 0.6)
        blend(aa(ring(ex, EY + 0.005, rx * 0.95, ry * 1.02, 0.0015)) * (v < EY - ry * 0.6) * ((u - ex) * s > -rx * 0.3), (0.45, 0.27, 0.2), 0.75)
        blend(aa(ring(ex + s * 0.01, EY + 0.02, 0.075 * E, 0.0675 * E, 0.003)) * (v > EY + 0.105), (0.74, 0.58, 0.34), 0.85)
    blend(aa(ell(0.5, 0.29, 0.007, 0.0045)), (0.88, 0.6, 0.54), 0.55)
    blend(aa(ring(0.5, 0.255, 0.048, 0.022, 0.0018), 0.0025) * (v < 0.255), (0.70, 0.30, 0.32))
    blend(aa(ell(0.5, 0.238, 0.018, 0.006)), (0.95, 0.55, 0.58), 0.45)
    return make_img('elf_face', img)


def hair_texture():
    H, W = 512, 256
    v = np.linspace(0, 1, H)[:, None]
    rng = np.random.default_rng(3)
    x = np.linspace(0, 1, W)
    streak = np.zeros(W)
    for _ in range(40):
        c, w, a = rng.random(), rng.uniform(0.003, 0.02), rng.uniform(-0.12, 0.12)
        streak += a * np.exp(-((x - c) / w) ** 2)
    base, tip, root = np.array([0.93, 0.79, 0.52]), np.array([1.0, 0.92, 0.72]), np.array([0.78, 0.60, 0.34])
    col = tip * (1 - v[..., None]) + base * v[..., None]
    r = np.clip((v - 0.85) / 0.15, 0, 1)[..., None] * 0.5
    col = col * (1 - r) + root * r
    col = col * (1 + streak[None, :, None]) + np.exp(-((v - 0.7) / 0.04) ** 2)[..., None] * 0.18
    img = np.ones((H, W, 4), np.float32)
    img[..., :3] = np.broadcast_to(col, (H, W, 3))
    return make_img('elf_hair', img)


def skirt_texture():
    H = W = 1024
    v, u = np.mgrid[0:H, 0:W].astype(np.float32)
    v /= H
    u /= W
    img = np.ones((H, W, 4), np.float32)
    img[..., :3] = (0.97, 0.95, 0.89)

    def blend(mask, col):
        m = np.clip(mask, 0, 1)[..., None]
        img[..., :3] = img[..., :3] * (1 - m) + np.array(col) * m

    LEAF = (0.36, 0.62, 0.36)
    blend((v < 0.035).astype(float), GOLD)
    blend(((v > 0.045) & (v < 0.052)).astype(float), GOLD)
    rng = np.random.default_rng(1)
    for k in range(10):
        u0 = (k + 0.5) / 10
        path = u0 + 0.018 * np.sin(v * 20 + k)
        d = np.abs(((u - path + 0.5) % 1) - 0.5)
        blend(np.clip(1 - (d - 0.0025) / 0.0015, 0, 1) * (v < 0.5) * (v > 0.05) * np.clip((0.5 - v) / 0.1, 0, 1), GOLD)
        for j in range(7):
            lv = 0.08 + j * 0.06 + rng.uniform(-0.01, 0.01)
            if lv > 0.48:
                break
            side = 1 if j % 2 else -1
            lu = u0 + 0.018 * np.sin(lv * 20 + k) + side * 0.013
            du = ((u - lu + 0.5) % 1) - 0.5
            dv = v - lv
            a = side * 0.7
            x = du * np.cos(a) + dv * np.sin(a)
            y = -du * np.sin(a) + dv * np.cos(a)
            blend(np.clip(1 - (np.sqrt((x / 0.013) ** 2 + (y / 0.006) ** 2) - 1) * 8, 0, 1), LEAF)
    return make_img('elf_skirt', img)


def overskirt_texture():
    vv, uu = np.mgrid[0:512, 0:512].astype(np.float32) / 512
    img = np.ones((512, 512, 4), np.float32)
    img[..., :3] = np.array((0.16, 0.40, 0.25)) * (0.9 + 0.1 * np.sin(uu * 80)[..., None])
    m = (vv < 0.06).astype(float)[..., None]
    img[..., :3] = img[..., :3] * (1 - m) + np.array(GOLD) * m
    img[..., :3][np.abs(vv - (0.09 + 0.02 * np.sin(uu * np.pi * 36))) < 0.004] = GOLD
    return make_img('elf_overskirt', img)


def harp_texture():
    H, W = 512, 128
    v, u = np.mgrid[0:H, 0:W].astype(np.float32)
    v /= H
    u /= W
    img = np.ones((H, W, 4), np.float32)
    base = np.array((0.80, 0.62, 0.30))
    img[..., :3] = base * 0.55
    for ph in (0, np.pi * 2 / 3, np.pi * 4 / 3):
        c = 0.5 + 0.32 * np.sin(v * np.pi * 24 + ph)
        shade = np.clip(1 - np.abs(u - c) / 0.09, 0, 1)
        img[..., :3] = np.maximum(img[..., :3], (base * (0.6 + 0.6 * shade[..., None])) * (shade[..., None] > 0))
    img[..., :3][(u < 0.06) | (u > 0.94)] = base * 1.1
    return make_img('harp_wood', img)


# ───────────────────────── 角色網格 ─────────────────────────
def build_body(M):
    sh, el, wr = Vector(SK['shoulder']), Vector(SK['elbow']), Vector(SK['wrist'])
    hp, kn, an = Vector(SK['hip']), Vector(SK['knee']), Vector(SK['ankle'])
    J = {
        # 軀幹：骨盆 → 下腹 → 腰（最細）→ 肋骨 → 胸 → 上胸 → 脖子
        'pelvis': ((0, 0.006, SK['pelvis_z'] - 0.01), (0.138, 0.100)),
        'lowab': ((0, 0.0, 1.0), (0.094, 0.070)),
        'waist': ((0, 0.006, SK['waist_z']), (0.068, 0.054)),
        'rib': ((0, 0.002, 1.185), (0.094, 0.070)),
        'chest': ((0, 0.004, 1.28), (0.104, 0.074)),
        'upchest': ((0, 0.012, 1.372), (0.094, 0.062)),
        # 脖子：從斜方肌往上延伸進頭部內側，露出的長度只有約 0.35 頭高
        'neckb': ((0, 0.012, 1.425), (0.055, 0.048)),
        'neckm': ((0, 0.004, 1.468), (0.042, 0.039)),
        'neckt': ((0, 0.008, HC.z - 0.05), (0.033, 0.033)),
        # 手臂：鎖骨 → 肩 → 三角肌 / 二頭肌 → 手肘 → 前臂肌腹 → 細手腕
        # 斜方肌：從脖子中段斜向肩膀，脖子才不會顯得細長
        'clL': ((0.062, 0.010, 1.434), (0.040, 0.034)),
        'shL': (tuple(sh), (0.046, 0.043)),
        'uaL': (tuple(sh.lerp(el, 0.33)), (0.041, 0.039)),
        'elL': (tuple(el), (0.029, 0.029)),
        'faL': (tuple(el.lerp(wr, 0.33)), (0.031, 0.028)),
        'wrL': (tuple(wr), (0.021, 0.016)),
        # 腿：大轉子 → 大腿 → 膝 → 小腿肚 → 腳踝 → 腳尖
        'hipL': (tuple(hp), (0.088, 0.084)),
        'thL': (tuple(hp.lerp(kn, 0.38) + Vector((-0.004, -0.004, 0))), (0.078, 0.074)),
        'knL': (tuple(kn), (0.044, 0.046)),
        'cfL': (tuple(kn.lerp(an, 0.33) + Vector((0, 0.012, 0))), (0.047, 0.050)),
        'lgL': (tuple(kn.lerp(an, 0.75)), (0.032, 0.033)),
        'anL': (tuple(an), (0.027, 0.029)),
        'toL': (SK['toe'], (0.031, 0.017)),
    }
    for k in list(J):
        if k.endswith('L'):
            (x, y, z), r = J[k]
            J[k[:-1] + 'R'] = ((-x, y, z), r)
    edges = [('pelvis', 'lowab'), ('lowab', 'waist'), ('waist', 'rib'), ('rib', 'chest'), ('chest', 'upchest'),
             ('upchest', 'neckb'), ('neckb', 'neckm'), ('neckm', 'neckt')]
    for S in 'LR':
        edges += [('upchest', f'cl{S}'), (f'cl{S}', f'sh{S}'), (f'sh{S}', f'ua{S}'), (f'ua{S}', f'el{S}'), (f'el{S}', f'fa{S}'), (f'fa{S}', f'wr{S}'),
                  ('pelvis', f'hip{S}'), (f'hip{S}', f'th{S}'), (f'th{S}', f'kn{S}'), (f'kn{S}', f'cf{S}'), (f'cf{S}', f'lg{S}'), (f'lg{S}', f'an{S}'), (f'an{S}', f'to{S}')]
    ob = metaball_body(J, edges)
    # 軀幹 / 骨盆與大腿根再輕微平滑（metaball 交界已經是圓順的過渡）
    smooth_weighted(ob, lambda c: soft_band(c.z, 1.28, 1.50, 0.03) * (1 - smoothstep(0.22, 0.27, abs(c.x))), 0.5, 4)
    smooth_weighted(ob, lambda c: soft_band(c.z, 0.76, 1.0, 0.03) * (1 - smoothstep(0.17, 0.22, abs(c.x))), 0.5, 3)
    shape_body(ob)
    shape_bust(ob)
    ob.data.materials.append(M['skin'])
    return ob


META_GAIN = 0.735  # 間距 0.2r 的 metaball 串，表面半徑 ≈ 0.735 r（在 Blender 5.2 實測）


def metaball_body(J, edges, voxel=0.0072):
    """以 metaball 沿骨架建立身體：關節與骨段的場會自然融合，肩膀、脖子、腋下、跨下都是圓順的過渡
    （Skin 修改器在分岔處會留下硬接縫）。之後轉網格並以 voxel remesh 得到均勻的四邊形拓撲。"""
    mb = bpy.data.metaballs.new('BodyMeta')
    mb.resolution = mb.render_resolution = 0.005
    mb.threshold = 0.6
    meta = link(bpy.data.objects.new('BodyMeta', mb))

    def add(co, rx, ry):
        r = max(rx, ry) / META_GAIN
        e = mb.elements.new()
        e.co = co
        e.radius = r
        e.stiffness = 2.0
        if abs(rx - ry) > 1e-4:
            e.type = 'ELLIPSOID'
            e.size_x, e.size_y, e.size_z = rx / max(rx, ry), ry / max(rx, ry), 1.0
        return r

    for n, (co, (rx, ry)) in J.items():
        add(Vector(co), rx, ry)
    for a_, b_ in edges:
        (pa, ra), (pb, rb) = J[a_], J[b_]
        pa, pb = Vector(pa), Vector(pb)
        L = (pb - pa).length
        step = 0.2 * min(min(ra), min(rb)) / META_GAIN
        n = max(1, int(L / step))
        for i in range(1, n):
            t = i / n
            add(pa.lerp(pb, t), ra[0] + (rb[0] - ra[0]) * t, ra[1] + (rb[1] - ra[1]) * t)

    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(meta.evaluated_get(dg))
    me.name = 'Body'
    bpy.data.objects.remove(meta, do_unlink=True)
    bpy.data.metaballs.remove(mb)
    ob = link(bpy.data.objects.new('Body', me))
    rm = ob.modifiers.new('Remesh', 'REMESH')
    rm.mode = 'VOXEL'
    rm.voxel_size = voxel
    rm.use_smooth_shade = True
    apply_mods(ob)
    for p in ob.data.polygons:
        p.use_smooth = True
    return ob


def smoothstep(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def soft_band(v, lo, hi, edge):
    return smoothstep(lo - edge, lo + edge, v) * (1 - smoothstep(hi - edge, hi + edge, v))


def smooth_weighted(ob, wfunc, factor, iters):
    """拉普拉斯平滑，每個頂點依 wfunc(co) 給 0~1 權重（邊界平順淡出，不會在範圍邊緣留下階梯）。"""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.verts.ensure_lookup_table()
    w = [wfunc(v.co) for v in bm.verts]
    nbrs = [[e.other_vert(v).index for e in v.link_edges] for v in bm.verts]
    idx = [i for i, wi in enumerate(w) if wi > 1e-3]
    for _ in range(iters):
        cos = [v.co.copy() for v in bm.verts]
        for i in idx:
            nb = nbrs[i]
            if not nb:
                continue
            avg = sum((cos[j] for j in nb), Vector()) / len(nb)
            bm.verts[i].co = cos[i] + (avg - cos[i]) * factor * w[i]
    bm.to_mesh(ob.data)
    bm.free()


def smooth_region(ob, pred, factor, iters):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    verts = [v for v in bm.verts if pred(v.co)]
    for _ in range(iters):
        bmesh.ops.smooth_vert(bm, verts=verts, factor=factor, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.to_mesh(ob.data)
    bm.free()


def shape_body(ob):
    """解剖細節：腰椎前凸的背部曲線、臀部、鎖骨、肩胛、膝蓋。"""
    for v in ob.data.vertices:
        p = v.co
        ax = abs(p.x)
        back = max(0.0, min(1.0, (p.y - 0.01) / 0.05))
        front = max(0.0, min(1.0, (-p.y - 0.01) / 0.05))
        if ax < 0.16:
            # 下背內凹（S 形脊椎）
            p.y -= 0.018 * g2(p.x, p.z, 0, 1.06, 0.07, 0.07) * back
            # 臀部：兩個圓潤的隆起，下緣收進大腿
            for s in (-1, 1):
                p.y += 0.034 * g2(p.x, p.z, s * 0.062, 0.865, 0.06, 0.055) * back
            # 肩胛骨
            for s in (-1, 1):
                p.y += 0.006 * g2(p.x, p.z, s * 0.065, 1.30, 0.035, 0.05) * back
            # 鎖骨：近水平的細稜線（略往外上斜），下方淺凹，中央胸骨上窩
            for s in (-1, 1):
                ridge_z = 1.398 + 0.012 * (abs(p.x) / 0.13)
                p.y -= 0.0015 * g2(abs(p.x), p.z, 0.07, ridge_z, 0.05, 0.007) * front
                p.y += 0.0012 * g2(abs(p.x), p.z, 0.075, ridge_z - 0.016, 0.045, 0.009) * front
            p.y += 0.005 * g2(p.x, p.z, 0, 1.396, 0.011, 0.01) * front
            # 上胸：鎖骨下方飽滿，平順地過渡到胸部上緣（避免胸上方出現平台）
            for s in (-1, 1):
                p.y -= 0.011 * g2(p.x, p.z, s * 0.05, 1.335, 0.055, 0.04) * front
            # 下腹微微的弧度
            p.y -= 0.006 * g2(p.x, p.z, 0, 0.98, 0.06, 0.04) * front
        # 臀線：腰（最細）→ 骨盆 → 大轉子（最寬，約與肩同寬）→ 大腿外側 → 膝，只推外側
        if 0.55 < p.z < 1.12 and 0.02 < ax < 0.19:  # ax < 0.19：排除同高度的前臂與手腕
            legness = min(1.0, max(0.0, (0.98 - p.z) / 0.12))
            c0 = 0.03 + 0.045 * legness
            outer = min(1.0, max(0.0, (ax - c0) / (0.08 - 0.04 * legness)))
            # metaball 身體已有正確體積，只補一點大轉子的弧度
            lat = 0.006 * math.exp(-((p.z - 0.875) / 0.11) ** 2)
            p.x += math.copysign(lat * outer, p.x)
        # 大腿內側往中線靠，減少腿縫
        if 0.62 < p.z < 0.86 and 0.02 < ax < SK['hip'][0]:
            p.x -= math.copysign(0.010 * math.exp(-((p.z - 0.76) / 0.08) ** 2) * (1 - ax / SK['hip'][0]), p.x)
        # 肩頭：三角肌的圓潤肩帽（往外上方鼓起），手臂不再像管子直接接上
        for s in (-1, 1):
            c = Vector((s * (SK['shoulder'][0] + 0.004), SK['shoulder'][1], SK['shoulder'][2] - 0.006))
            dv = p - c
            dist = dv.length
            if dist < 0.12:
                out_dir = Vector((s, 0, 0.45)).normalized()
                facing = smoothstep(-0.5, 0.4, dv.normalized().dot(out_dir))
                side = smoothstep(0.06, 0.12, p.x * s)
                p += dv.normalized() * 0.010 * math.exp(-(dist / 0.055) ** 2) * facing * side
        # 膝蓋骨
        if 0.38 < p.z < 0.56:
            for s in (-1, 1):
                p.y -= 0.007 * g2(p.x, p.z, s * SK['knee'][0], SK['knee'][2] + 0.01, 0.022, 0.025) * front
    ob.data.update()


BUST = {'x': 0.066, 'z': 1.257, 'amp': 0.084, 'rx': 0.077, 'rz_up': 0.095, 'rz_down': 0.064}


def shape_bust(ob):
    """胸部：兩個高斯隆起（下緣較飽滿、上緣平順過渡），中間保留自然的凹線。胸衣由身體複製，會跟著變形。"""
    B = BUST
    # 身體以 Subsurf 3 級產生，軀幹一圈 32+ 頂點，足夠塑形
    for v in ob.data.vertices:
        p = v.co
        if p.y > 0.02 or not (1.15 < p.z < 1.38) or abs(p.x) > 0.16:
            continue
        dz = p.z - B['z']
        rz = B['rz_up'] if dz > 0 else B['rz_down']
        k = 0.0
        for s in (-1, 1):
            # 半球形輪廓（比高斯圓潤、不會變成錐狀），外圈平滑淡出
            # 圓頂輪廓：中央飽滿、邊緣斜率平順歸零（不會在外圈留下摺痕）
            r = math.sqrt(((p.x - s * B['x']) / B['rx']) ** 2 + (dz / rz) ** 2)
            k = max(k, (1 - smoothstep(0.0, 1.25, r)) ** 0.8)  # 0.8 次方：圓頂更飽滿、不尖
        front = min(1.0, max(0.0, -p.y / 0.06))  # 只推正面
        sgn = 1 if p.x > 0 else -1
        p.y -= B['amp'] * k * front
        p.x += sgn * B['amp'] * 0.22 * k * front  # 自然地微微朝外
        p.z -= 0.004 * k * front  # 微微下垂，下半部較飽滿
        # 胸部外側延伸到腋下
        p.x += sgn * 0.007 * g2(abs(p.x), p.z, 0.105, B['z'] + 0.01, 0.025, 0.05) * front
    ob.data.update()
    # 胸口整體再輕微平滑，消除位移疊加造成的細小起伏
    smooth_weighted(ob, lambda c: soft_band(c.z, 1.16, 1.42, 0.03) * (1 - smoothstep(0.13, 0.17, abs(c.x))) * smoothstep(0.0, -0.03, c.y), 0.5, 3)


def g2(x, z, cx, cz, sx, sz):
    return math.exp(-((x - cx) / sx) ** 2 - ((z - cz) / sz) ** 2)


# 臉部特徵在頭部中心 HC 的相對高度（公尺）；需與 face_texture() 的眼睛 / 鼻子 / 嘴巴位置對齊
# 貼圖投影：u = 0.5 + x / 0.21，v = 0.5 + z / 0.24
FACE = {'eye_z': -0.018, 'eye_x': 0.042, 'nose_tip_z': -0.040, 'mouth_z': -0.061, 'chin_z': -0.108}


def sculpt_face(d):
    """在頭部的相對座標 d（以 HC 為原點）上雕刻鼻樑、鼻頭、嘴唇、下巴與顴骨。只處理正面。"""
    x, y, z = d.x, d.y, d.z
    if y > -0.02:
        return d
    F = FACE
    front = min(1.0, (-y - 0.02) / 0.05)
    push = 0.0  # 往前（-Y）推的量
    # 鼻樑：眉心往鼻頭逐漸隆起的細脊
    if F['nose_tip_z'] - 0.01 < z < F['eye_z'] + 0.02:
        t = min(1.0, max(0.0, (F['eye_z'] + 0.01 - z) / (F['eye_z'] + 0.01 - F['nose_tip_z'])))
        push += (0.0015 + 0.0075 * t ** 1.4) * math.exp(-(x / (0.0045 + 0.002 * t)) ** 2)
    # 鼻頭與鼻翼
    push += 0.0055 * g2(x, z, 0, F['nose_tip_z'], 0.0065, 0.0055)
    for s in (-1, 1):
        push += 0.0018 * g2(x, z, s * 0.0065, F['nose_tip_z'] - 0.002, 0.004, 0.004)
    # 鼻下內收（人中與鼻底的轉折）
    push -= 0.003 * g2(x, z, 0, F['nose_tip_z'] - 0.008, 0.01, 0.003)
    # 人中淺溝
    push -= 0.0008 * g2(x, z, 0, (F['nose_tip_z'] + F['mouth_z']) / 2 - 0.002, 0.0025, 0.006)
    # 上唇（中央唇珠）與下唇
    m = F['mouth_z']
    push += 0.0042 * g2(x, z, 0, m + 0.0045, 0.015, 0.0036)
    push += 0.0012 * g2(x, z, 0, m + 0.0035, 0.004, 0.002)
    push += 0.0050 * g2(x, z, 0, m - 0.0058, 0.012, 0.0042)
    # 嘴縫與嘴角凹陷
    push -= 0.0022 * g2(x, z, 0, m, 0.017, 0.0013)
    for s in (-1, 1):
        push -= 0.0018 * g2(x, z, s * 0.019, m + 0.0005, 0.004, 0.004)
    # 唇下溝與下巴前凸
    push -= 0.0018 * g2(x, z, 0, m - 0.014, 0.014, 0.004)
    push += 0.0045 * g2(x, z, 0, F['chin_z'] + 0.022, 0.013, 0.012)
    # 眼窩微凹、眉骨與顴骨
    for s in (-1, 1):
        push -= 0.0022 * g2(x, z, s * F['eye_x'], F['eye_z'], 0.024, 0.016)
        push += 0.0012 * g2(x, z, s * 0.04, F['eye_z'] + 0.03, 0.03, 0.008)
        d.x += s * 0.0028 * g2(x, z, s * 0.068, F['eye_z'] - 0.022, 0.016, 0.016) * front
    d.y -= push * front
    return d


FACE_SHAPE = {
    'cheek_scale': 1.0,  # 顴骨寬度倍率（參考角色臉頰較寬）
    'cheek_z': -0.022,   # 顴骨（臉最寬處，眼睛下緣）
    'chin_z': -0.098,    # 下巴尖的高度
    'chin_hw': 0.029,    # 下巴半寬（小而圓）
    'cheek_soft': 0.004, # 臉頰的柔和外凸，避免直線太硬
    'lower_len': 1.03,   # 下半臉長度倍率（越小臉越短）
}


def build_head(M):
    SX, SY, SZ = 0.092, 0.102, 0.112
    F = FACE_SHAPE
    bm = bmesh.new()
    # 臉部雕刻需要較高的解析度（鼻樑、唇形）
    bmesh.ops.create_uvsphere(bm, u_segments=112, v_segments=80, radius=1.0)
    base = []
    for vt in bm.verts:
        x, y, z = vt.co
        yu = y
        key = round(z, 5)
        if z < 0:
            k = (-z) ** 1.5
            # 側臉：正面幾乎垂直，下半臉只微微後收（不要像往後仰）
            y *= 1 - 0.13 * k * (1 if y < 0 else 0.55)
            z *= F['lower_len']
            if y < 0:
                y += 0.012 * k
            # 下巴要是最低點：頭的底面往後逐漸抬高（下顎底線往脖子斜上），不是在臉正下方垂成碗狀
            back_t = min(1.0, max(0.0, (yu + 0.75) / 1.5))
            back_t = back_t * back_t * (3 - 2 * back_t)
            lift = 0.42 * (-z) ** 1.25 * back_t * SZ
        else:
            lift = 0.0
        if y < 0:
            y *= 0.92  # 臉的正面較平
        if z > 0:  # 圓一點的頭頂
            k = min(1, z * SZ / 0.11)
            x *= 1 + 0.10 * math.sin(k * math.pi * 0.8)
            y *= 1 + 0.06 * math.sin(k * math.pi * 0.8)
        base.append((vt, Vector((x * SX, y * SY, z * SZ)), yu, key, lift))

    # 臉型（正面輪廓）：顴骨以下改成「直線下顎 + 小圓下巴」的 V 臉。
    # 以每一圈（同高度）正面頂點的最大寬度為基準縮放 x；後腦（被頭髮蓋住）保持寬度。
    rings = {}
    for vt, d, yu, key, lift in base:
        rings.setdefault(key, []).append((vt, d, yu))
    zmin = min(d.z for _, d, yu, _, _ in base if yu < -0.05)  # 下巴最低點（正面）
    front_w = {k_: max((abs(d.x) for _, d, yu in r if yu < 0.1), default=0.0) for k_, r in rings.items()}
    ring_z = {k_: max(d.z for _, d, yu in r if yu < 0.1) if any(yu < 0.1 for _, _, yu in r) else 0 for k_, r in rings.items()}
    hw_cheek = max(front_w[k_] for k_ in rings if abs(ring_z[k_] - F['cheek_z']) < 0.006)

    # 下半臉的寬度比例（相對顴骨寬度，t = 由下巴往上、以「下巴→眼睛」為 0~1）：
    # 依參考角色量測的輪廓——下巴小而圓，但往上很快變飽滿（柔和的圓 V 臉，不是尖下巴）
    W_RATIO = [(0.0, 0.14), (0.125, 0.43), (0.25, 0.62), (0.375, 0.70), (0.5, 0.82), (0.625, 0.91), (0.75, 0.94), (0.875, 0.97), (1.0, 1.0)]
    # 正面深度（相對額頭平面，單位＝頭高，正值＝在額頭後方）；鼻子、嘴唇由 sculpt_face 另外疊加
    D_PROFILE = [(0.0, 0.085), (0.12, 0.045), (0.22, 0.018), (0.35, 0.0), (0.45, -0.012), (0.62, -0.02), (0.78, -0.02), (0.9, -0.008), (1.0, 0.004), (1.3, 0.0)]

    def lerp_table(tab, t):
        t = min(tab[-1][0], max(tab[0][0], t))
        for (t0, v0), (t1, v1) in zip(tab, tab[1:]):
            if t <= t1:
                u = (t - t0) / (t1 - t0)
                u = u * u * (3 - 2 * u)
                return v0 + (v1 - v0) * u
        return tab[-1][1]

    eye_z = FACE['eye_z']
    head_h = (max(d.z for _, d, _, _, _ in base) - zmin)

    def t_of(z):
        return (z - zmin) / (eye_z - zmin)

    for k_, r in rings.items():
        z = ring_z[k_]
        if z >= F['cheek_z'] or front_w[k_] < 1e-5:
            continue
        hw = hw_cheek * F['cheek_scale'] * lerp_table(W_RATIO, t_of(z))
        blend = min(1.0, (F['cheek_z'] - z) / 0.012)  # 顴骨下方平順過渡
        factor = 1 + (hw / front_w[k_] - 1) * blend
        for vt, d, yu in r:
            wf = min(1.0, max(0.0, (0.45 - yu) / 0.3))  # 前半到側面完整套用 → 耳後淡出（被頭髮蓋住）
            d.x *= 1 + (factor - 1) * wf

    # 側臉：把下半臉往前帶，讓下巴、嘴、鼻下對齊參考的輪廓線（臉的正面接近垂直）
    def front_y_at(r):
        c = [d.y for _, d, yu in r if abs(d.x) < 0.006 and yu < 0]
        return min(c) if c else None
    fh_ring = min(rings, key=lambda k_: abs(ring_z[k_] - (eye_z + 0.045)))
    fh_y = front_y_at(rings[fh_ring])
    deltas = {}
    for k_, r in rings.items():
        z = ring_z[k_]
        cur = front_y_at(r)
        if z > eye_z + 0.03 or cur is None:
            continue
        deltas[k_] = fh_y + lerp_table(D_PROFILE, t_of(z)) * head_h - cur  # 負值＝往前
    # 相鄰圈的修正量做移動平均，避免一圈一圈的波紋
    keys = sorted(deltas)
    smooth_d = {}
    for i, k_ in enumerate(keys):
        win = [deltas[keys[j]] for j in range(max(0, i - 3), min(len(keys), i + 4))]
        smooth_d[k_] = sum(win) / len(win)
    for k_, r in rings.items():
        if k_ not in smooth_d:
            continue
        z = ring_z[k_]
        delta = smooth_d[k_]
        fade = min(1.0, (eye_z + 0.03 - z) / 0.02)
        hw = max(1e-4, max(abs(d.x) for _, d, yu in r if yu < 0.1))
        for vt, d, yu in r:
            if yu > 0.2:
                continue
            front = min(1.0, max(0.0, (0.2 - yu) / 0.6))
            across = max(0.0, 1 - (abs(d.x) / (hw * 1.05)) ** 2)
            d.y += delta * fade * front * (0.35 + 0.65 * across)
    for vt, d, yu, key, lift in base:
        d.z += lift  # 寬度依水平的圈計算完之後才抬高後方底面
        vt.co = sculpt_face(d) + HC
    me = bpy.data.meshes.new('Head')
    bm.to_mesh(me)
    bm.free()
    head = link(bpy.data.objects.new('Head', me))
    # 下顎兩側與下巴底面輕微平滑（避開正面中央的鼻子與嘴唇）
    ez = HC.z + FACE['eye_z']
    smooth_weighted(head, lambda c: (1 - smoothstep(ez - 0.035, ez - 0.01, c.z))
                    * (0.25 + 0.75 * smoothstep(0.012, 0.035, abs(c.x - HC.x))) * (1 - smoothstep(0.02, 0.06, c.y - HC.y)), 0.5, 8)
    uvl = me.uv_layers.new(name='UVMap')
    for p in me.polygons:
        p.use_smooth = True
        for li in p.loop_indices:
            vi = me.loops[li].vertex_index
            co = me.vertices[vi].co
            # 整個前半部都用正面投影（臉部以外是純膚色），接縫落在耳後、被頭髮蓋住
            v = min(0.99, max(0.01, 0.5 + (co.z - HC.z) / 0.24))
            if co.y - HC.y < 0.0:
                uvl.data[li].uv = (min(0.99, max(0.01, 0.5 + (co.x - HC.x) / 0.21)), v)
            else:
                # 後腦對應到同側的貼圖邊緣（純膚色），跨越邊界的三角形才不會內插到眼睛
                uvl.data[li].uv = (0.99 if co.x > HC.x else 0.01, v)
    me.materials.append(M['face'])
    return head


def head_pt(theta, z):
    dz = (z - HC.z - 0.01) / 0.125
    r = math.sqrt(max(0.02, 1 - dz * dz))
    return Vector((math.sin(theta) * 0.106 * r * 1.04, -math.cos(theta) * 0.114 * r + 0.008, 0)) + Vector((HC.x, HC.y, z))


def build_hair(M):
    random.seed(5)
    parts = []
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=40, v_segments=24, radius=1)
    for vt in bm.verts:
        x, y, z = vt.co
        zz = z * 0.122
        if zz < 0:
            zz *= 1.15
        vt.co = HC + Vector((x * 0.104 * (1 + 0.08 * max(0, z)), y * 0.113, zz)) + Vector((0, 0.008, 0.01))
    kill = [vt for vt in bm.verts if (vt.co.z < HC.z + 0.055 and vt.co.y < HC.y + 0.02) or vt.co.z < HC.z - 0.085]
    bmesh.ops.delete(bm, geom=kill, context='VERTS')
    me = bpy.data.meshes.new('HairCap')
    bm.to_mesh(me)
    bm.free()
    cap = link(bpy.data.objects.new('HairCap', me))
    uv = me.uv_layers.new(name='UVMap')
    for p in me.polygons:
        p.use_smooth = True
        for li in p.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            uv.data[li].uv = ((math.atan2(co.x, -(co.y - HC.y)) / math.pi + 1) * 2 % 1, 0.75 + (co.z - HC.z) / 0.5)
    solidify(cap, 0.006)
    parts.append(cap)

    def strand(theta, z0, length, width, fan, waves, phase, drift, n=16, depth=0.011, curl=0.022):
        pts, rw, rd, ups = [], [], [], []
        s = head_pt(theta, z0)
        rad0 = math.hypot(s.x - HC.x, s.y - HC.y)
        for i in range(n):
            t = i / (n - 1)
            th = theta + drift * t
            r = rad0 + 0.012 + fan * (t ** 0.6)
            d = Vector((math.sin(th), -math.cos(th), 0))
            side = Vector((math.cos(th), math.sin(th), 0))
            p = Vector((HC.x, HC.y, z0 - length * t)) + d * r + side * math.sin(t * math.pi * waves + phase) * curl * min(1, t * 3)
            p += d * math.sin(t * math.pi * waves * 0.5 + phase) * 0.01 * t
            pts.append(p)
            ups.append(side)
            w = width * (0.8 + 0.6 * math.sin(min(1, t * 1.3) * math.pi * 0.5)) * (1 - 0.85 * t ** 2.2)
            rw.append(max(0.002, w))
            rd.append(max(0.0015, depth * (1 - 0.7 * t)))
        return sweep('strand', pts, rw, rd, seg=8, ups=ups)

    for i in range(26):
        th = math.radians(78 + 204 * i / 25) + random.uniform(-0.05, 0.05)
        sidew = abs(math.sin(th))
        parts.append(strand(th, HC.z + random.uniform(0.02, 0.07), random.uniform(0.80, 0.95) - 0.12 * sidew,
                            random.uniform(0.032, 0.042), 0.055 + 0.12 * sidew + random.uniform(0, 0.03),
                            random.uniform(2.5, 4), random.uniform(0, 6.28), (math.pi - th) * 0.25))
    for i in range(12):
        th = math.radians(110 + 140 * i / 11)
        parts.append(strand(th, HC.z + 0.03, 0.72, 0.05, 0.05, 3, i, (math.pi - th) * 0.2, depth=0.014))
    for s in (-1, 1):  # 臉側髮束
        for j, (th, L, w) in enumerate([(62, 0.36, 0.024), (72, 0.42, 0.026)]):
            st = head_pt(math.radians(th) * s, HC.z + 0.06)
            pts, rw, rd, ups = [], [], [], []
            for i in range(14):
                t = i / 13
                pts.append(st + Vector((s * (0.012 + 0.025 * t) + s * 0.01 * math.sin(t * math.pi * 2.5 + j), -0.02 * t - 0.01 * math.sin(t * 3), -L * t)))
                ups.append(Vector((0, -1, 0)).lerp(Vector((s, 0, 0)), 0.3))
                rw.append(max(0.003, w * (1 - 0.8 * t ** 2)))
                rd.append(0.008 * (1 - 0.6 * t))
            parts.append(sweep('side', pts, rw, rd, seg=8, ups=ups))
    for i in range(11):  # 瀏海
        k = (i / 10) * 2 - 1
        if abs(k) < 0.08:
            continue
        th = k * math.radians(72)
        top = head_pt(th * 0.5, HC.z + 0.125) + Vector((0, -0.01, 0))
        end = head_pt(th + 0.18 * k, HC.z + 0.032 - 0.02 * k * k + random.uniform(-0.006, 0.006)) + Vector((0, -0.018, 0))
        mid = (top + end) / 2 + Vector((0, -0.045, 0)) + Vector((math.sin(th), -math.cos(th), 0)) * 0.02
        pts = [top * (1 - t) ** 2 + mid * 2 * t * (1 - t) + end * t * t for t in (j / 9 for j in range(10))]
        parts.append(sweep('bang', pts, [max(0.002, 0.024 * (1 - (j / 9) ** 1.8)) for j in range(10)], [0.006] * 10,
                           seg=6, ups=[Vector((math.cos(th), math.sin(th), 0))] * 10))
    hair = join(parts, 'Hair')
    hair.data.materials.clear()
    hair.data.materials.append(M['hair'])
    return hair


def build_ears(M):
    ears = []
    for s in (-1, 1):
        base, tip = Vector((s * 0.088, 0.012, 1.598)), Vector((s * 0.215, 0.05, 1.672))
        pts, rw, rd = [], [], []
        for i in range(10):
            t = i / 9
            pts.append(base.lerp(tip, t) + Vector((0, 0, 0.012 * math.sin(t * math.pi))))
            rw.append(max(0.002, 0.034 * math.sin(min(1, t + 0.15) * math.pi * 0.55) * (1 - t ** 1.5) + 0.002))
            rd.append(max(0.002, 0.008 * (1 - t)))
        ears.append(sweep('Ear', pts, rw, rd, seg=8, ups=[Vector((0, 0, 1))] * 10))
    e = join(ears, 'Ears')
    e.data.materials.append(M['skin'])
    return e


HAND_BONES = {S: (tuple(skv('wrist', s)), tuple(skv('hand_tip', s))) for S, s in (('L', 1), ('R', -1))}


def build_hands(M):
    """手掌 + 五指（自然微彎）。依手骨方向建立局部座標：a=手指方向、w=掌寬方向（拇指在前 -Y）、n=掌心方向（朝向身體）。"""
    parts = []
    for S, (h, t) in HAND_BONES.items():
        s = 1 if S == 'L' else -1
        wrist, tip = Vector(h), Vector(t)
        a = (tip - wrist).normalized()
        w = Vector((0, -1, 0))  # 拇指側（正面）
        w = (w - a * w.dot(a)).normalized()
        n = a.cross(w).normalized()
        if n.x * s > 0:  # 掌心要朝向身體
            n = -n

        # 手掌：扁平的掃掠體，從手腕往指根變寬
        base = wrist + a * 0.004
        pts, rw, rd = [], [], []
        for i in range(8):
            t_ = i / 7
            # 起點藏在前臂內，開口不會露出來
            pts.append(base + a * (0.088 * t_ - 0.016) + n * 0.003 * math.sin(t_ * math.pi))
            rw.append(0.019 + 0.008 * math.sin(min(1.0, t_ * 1.25) * math.pi * 0.5) - 0.003 * t_ ** 3)
            rd.append(0.0105 - 0.0015 * t_)
        parts.append(sweep('palm', pts, rw, rd, seg=12, ups=[w] * 8))

        # 手指：(在掌寬上的位置, 長度, 半徑, 彎曲)；index 在拇指側
        knuckle = base + a * 0.068
        fingers = [(0.66, 0.062, 0.0068, 1.0), (0.22, 0.070, 0.0071, 1.05), (-0.22, 0.065, 0.0068, 1.1), (-0.66, 0.051, 0.0060, 1.2)]
        for off, L, r, curl in fingers:
            start = knuckle + w * off * 0.024 - a * abs(off) * 0.006
            pts, rw, rd = [], [], []
            d = (a + w * off * 0.08).normalized()
            p = start.copy()
            segs = [(0.08 * curl, 0.45), (0.34 * curl, 0.30), (0.34 * curl, 0.25)]  # 三節：每節往掌心彎的角度
            n_pts = 0
            for ang, frac in segs:
                d = (d * math.cos(ang) + n * math.sin(ang)).normalized()
                for k in range(4):
                    pts.append(p.copy())
                    q = n_pts / 11
                    rw.append(r * (1 - 0.3 * q))
                    rd.append(r * 0.9 * (1 - 0.3 * q))
                    n_pts += 1
                    p += d * L * frac / 4
            pts.append(p.copy())
            rw.append(r * 0.62)
            rd.append(r * 0.55)
            parts.append(sweep('finger', pts, rw, rd, seg=8, ups=[w] * len(pts)))

        # 拇指：從掌根拇指側斜出，朝前並往掌心收
        tstart = base + a * 0.012 + w * 0.017 + n * 0.005
        d = (a * 0.8 + w * 0.38 + n * 0.3).normalized()
        p = tstart.copy()
        pts, rw, rd = [], [], []
        for i, (ang, seglen) in enumerate([(0.0, 0.022), (0.25, 0.018), (0.25, 0.016)]):
            d = (d * math.cos(ang) + (n * 0.7 + a * 0.3).normalized() * math.sin(ang)).normalized()
            for k in range(3):
                pts.append(p.copy())
                rw.append(0.0092 - 0.0004 * (i * 3 + k))
                rd.append(0.0082 - 0.00035 * (i * 3 + k))
                p += d * seglen / 3
        pts.append(p.copy())
        rw.append(0.0052)
        rd.append(0.0047)
        parts.append(sweep('thumb', pts, rw, rd, seg=8, ups=[n] * len(pts)))
    hands = join(parts, 'Hands')
    hands.data.materials.append(M['skin'])
    return hands


SKIRT_TOP = SK['waist_z'] + 0.005  # 高腰：裙頭在腰最細處
SKIRT_LEN = SKIRT_TOP - 0.012


def smax(a, b, p=6):
    return (a ** p + b ** p) ** (1 / p)


def skirt_prof(scale, z_top=SKIRT_TOP, z_bot=0.012):
    """裙子輪廓：上段貼合腰臀曲線（最寬在大轉子），以下才 A 字展開；背面略長形成小拖尾。"""
    def f(t, a):
        z = z_top + (z_bot - z_top) * t
        cone = 0.088 + 0.36 * (t ** 1.25)
        # 大轉子以下維持最寬，裙子只會一路往下展開（不會在臀下縮回成花瓶狀）
        hip = 0.104 + 0.080 * (math.exp(-((z - 0.87) / 0.13) ** 2) if z > 0.87 else 1.0)
        back = 1 + 0.18 * t * max(0, -math.cos(a))
        depth = 0.80 + 0.06 * max(0.0, -math.cos(a))  # 背面（臀部）比正面深
        rx = smax(cone * 1.08, hip)
        ry = smax(cone * 0.92, hip * depth)
        return rx * scale * back, ry * scale * back
    return f


def build_dress(M, body):
    out = []
    inner = lathe('SkirtInner', SKIRT_TOP, 0.012, skirt_prof(1.0), rings=20, seg=72, a0=math.pi, a1=3 * math.pi, wave=0.012, nw=14)
    inner.data.materials.append(M['dress'])
    solidify(inner, 0.006, 0)
    out.append(inner)
    op = math.radians(38)
    over = lathe('Overskirt', SKIRT_TOP + 0.012, 0.03, skirt_prof(1.09, SKIRT_TOP + 0.012, 0.03), rings=20, seg=60, a0=op, a1=2 * math.pi - op, wave=0.03, nw=9)
    over.data.materials.append(M['over'])
    solidify(over, 0.006, 0)
    out.append(over)
    trims = []
    prof = skirt_prof(1.10, SKIRT_TOP + 0.012, 0.03)
    for a in (op, 2 * math.pi - op):
        pts = []
        for i in range(20):
            t = i / 19
            rx, ry = prof(t, a)
            w = 0.03 * t ** 2 * math.sin(a * 9)
            pts.append(Vector((math.sin(a) * (rx + w + 0.004), -math.cos(a) * (ry + w + 0.004), SKIRT_TOP + 0.012 - (SKIRT_TOP - 0.018) * t)))
        trims.append(sweep('trim', pts, [0.011] * 20, [0.004] * 20, seg=6, cap=False, ups=[Vector((math.cos(a), math.sin(a), 0))] * 20))
    trims.append(lathe('Belt', SKIRT_TOP + 0.03, SKIRT_TOP - 0.012, lambda t, a: (0.096, 0.077), rings=3, seg=48))
    # 胸衣：從身體複製並外推。上緣為甜心領（胸線上方，正面 V 字凹），排除手臂的面
    BODICE_TOP = BUST['z'] + 0.062

    def neckline(x, y):
        # 甜心領：正面中央 V 字、胸上方兩個柔和的弧，往側面 / 背面平順升高
        front = min(1.0, max(0.0, -y / 0.04 + 0.5))
        ax = abs(x)
        v = -0.034 * math.exp(-(x / 0.026) ** 2) + 0.010 * math.exp(-((ax - 0.062) / 0.035) ** 2)
        return BODICE_TOP + front * v + (1 - front) * 0.012

    sh_l, el_l = Vector(SK['shoulder']), Vector(SK['elbow'])
    bm = bmesh.new()
    bm.from_mesh(body.data)
    keep = set()
    for f in bm.faces:
        c = f.calc_center_median()
        top = neckline(c.x, c.y)
        if not (0.94 < c.z < top):
            continue
        cm = Vector((abs(c.x), c.y, c.z))
        q, fr = intersect_point_line(cm, sh_l, el_l)
        d_arm = (cm - sh_l.lerp(el_l, min(1, max(0, fr)))).length
        if d_arm > 0.05 and abs(c.x) < 0.16:
            keep.add(f)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f not in keep], context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')  # 刪面後殘留的孤立點 / 線
    # 上緣邊界點對齊到平滑的領口曲線（否則會沿著面的邊緣呈鋸齒狀）
    for vt in bm.verts:
        if vt.is_boundary and vt.co.z > BUST['z'] - 0.02:
            vt.co.z = neckline(vt.co.x, vt.co.y)
    for vt in bm.verts:
        vt.co += vt.normal * 0.006
    # 領口邊界（給金邊用）：上緣的邊界頂點，依角度排序
    # 只取領口上緣：每個角度桶取最高的邊界點（排除腋下的袖孔邊界）
    rim = [vt.co.copy() for vt in bm.verts if vt.is_boundary and vt.co.z > BUST['z']]
    me = bpy.data.meshes.new('Bodice')
    bm.to_mesh(me)
    bm.free()
    bod = link(bpy.data.objects.new('Bodice', me))
    for p in me.polygons:
        p.use_smooth = True
    me.materials.clear()
    me.materials.append(M['bodice'])
    dec = bod.modifiers.new('Dec', 'DECIMATE')  # 平滑的布面不需要身體那麼密的拓撲
    dec.ratio = 0.35
    solidify(bod, 0.004)
    out.append(bod)

    rim.sort(key=lambda v: math.atan2(v.x, -v.y))
    # 以角度分桶平均，得到平滑的領口曲線並稍微外推
    buckets = {}
    for v in rim:
        k = round(math.atan2(v.x, -v.y) / (math.pi / 36))
        buckets.setdefault(k, []).append(v)
    pts = []
    for k in sorted(buckets):
        vs = sorted(buckets[k], key=lambda v: -v.z)[:3]
        c = sum(vs, Vector()) / len(vs)
        out_dir = Vector((c.x, c.y, 0)).normalized()
        pts.append(c + out_dir * 0.004)
    pts.append(pts[0].copy())
    trims.append(sweep('neckline', pts, [0.0065] * len(pts), [0.003] * len(pts), seg=6, cap=False, ups=[Vector((0, 0, 1))] * len(pts)))

    # 飾品貼著身體表面：先算大致位置，再投影到最近的皮膚表面並沿法線外推
    bm_b = bmesh.new()
    bm_b.from_mesh(body.data)
    bvh = BVHTree.FromBMesh(bm_b)

    def on_skin(pt, off):
        loc, nrm, _, _ = bvh.find_nearest(pt)
        return loc + nrm * off if loc is not None else pt

    nz = SK['neck_z'] + 0.03  # 項鍊：掛在脖子根部，前方垂到胸骨上方
    pts = []
    for i in range(33):
        a = -math.pi * 0.5 + math.pi * i / 32
        pts.append(on_skin(Vector((math.sin(a) * 0.06, -math.cos(a) * 0.05 + 0.012, nz - 0.055 * math.cos(a) ** 3)), 0.004))
    trims.append(sweep('necklace', pts, [0.0035] * 33, [0.0035] * 33, seg=6, cap=False))
    gem_at = on_skin(Vector((0, -0.06, nz - 0.064)), 0.009)
    cuff_pts = {}
    for s in (-1, 1):  # 上臂金環（上臂約 30% 處）
        sh_, el_ = skv('shoulder', s), skv('elbow', s)
        c = sh_.lerp(el_, 0.3)
        axis = (el_ - sh_).normalized()
        side = axis.cross(Vector((0, 1, 0))).normalized()
        up = axis.cross(side)
        pts = [on_skin(c + (side * math.cos(2 * math.pi * k / 24) + up * math.sin(2 * math.pi * k / 24)) * 0.05, 0.003) for k in range(25)]
        trims.append(sweep('cuff', pts, [0.006] * 25, [0.003] * 25, seg=6, cap=False, ups=[axis] * 25))
        cuff_pts[s] = c
    gold = join(trims, 'GoldTrim')
    gold.data.materials.append(M['gold'])
    out.append(gold)

    bm_b.free()
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.013, location=gem_at)
    gem = bpy.context.active_object
    gem.name = 'Gem'
    gem.scale = (1, 0.6, 1.4)
    bpy.ops.object.transform_apply(scale=True)
    gem.data.materials.append(M['gem'])
    out.append(gem)

    sleeves = []  # 半透明喇叭紗袖：從金環下方開始，袖口垂到手腕下
    for s in (-1, 1):
        sh_ = cuff_pts[s] + Vector((0, 0, -0.012))
        wr = skv('wrist', s, dz=-0.01)
        pts, rw, rd = [], [], []
        for i in range(14):
            t = i / 13
            pts.append(sh_.lerp(wr, t * 1.1) + Vector((0, 0.01 * t, -0.03 * t * t)))
            r = 0.046 + 0.075 * t ** 1.6
            rw.append(r)
            rd.append(r * 1.1)
        sleeves.append(sweep('Sleeve', pts, rw, rd, seg=16, cap=False, ups=[Vector((0, 1, 0))] * 14))
    sl = join(sleeves, 'Sleeves')
    sl.data.materials.append(M['sheer'])
    out.append(sl)

    bm = bmesh.new()  # 鞋
    bm.from_mesh(body.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_center_median().z > 0.13], context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    for vt in bm.verts:
        vt.co += vt.normal * 0.006
    me = bpy.data.meshes.new('Shoes')
    bm.to_mesh(me)
    bm.free()
    shoes = link(bpy.data.objects.new('Shoes', me))
    for p in me.polygons:
        p.use_smooth = True
    me.materials.clear()
    me.materials.append(M['shoe'])
    out.append(shoes)
    return out


def flower_mesh(center, normal, size, M):
    bm = bmesh.new()
    for k in range(5):
        ret = bmesh.ops.create_uvsphere(bm, u_segments=8, v_segments=5, radius=size)
        rot = Matrix.Rotation(2 * math.pi * k / 5, 3, 'Z')
        for vt in ret['verts']:
            vt.co.x *= 0.55
            vt.co.z *= 0.25
            vt.co.y += size * 0.9
            vt.co = rot @ vt.co
    me = bpy.data.meshes.new('fl')
    bm.to_mesh(me)
    bm.free()
    o = link(bpy.data.objects.new('fl', me))
    o.location = center
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(normal)
    me.materials.append(M['petal'])
    for p in me.polygons:
        p.use_smooth = True
    bpy.ops.mesh.primitive_uv_sphere_add(segments=8, ring_count=5, radius=size * 0.45, location=center + normal * size * 0.2)
    c = bpy.context.active_object
    c.data.materials.append(M['leafgold'])
    return [o, c]


def leaf_mesh(base, direction, side, L, mat):
    pts = [base + direction * L * t / 7 for t in range(8)]
    o = sweep('leaf', pts, [max(0.0015, L * 0.3 * math.sin(math.pi * t / 7)) for t in range(8)], [0.0015] * 8, seg=6, cap=False, ups=[side] * 8)
    o.data.materials.append(mat)
    return o


def build_crown(M):
    random.seed(11)
    parts = []
    pts = []
    for i in range(49):
        a = 2 * math.pi * i / 48
        ca = math.cos(a)
        pts.append(HC + Vector((math.sin(a) * 0.112, -ca * 0.118 + 0.006, 0.075 - (0.03 * ca * ca if ca < 0 else 0) + (0.02 * ca if ca > 0 else 0))))
    band = sweep('band', pts, [0.004] * 49, [0.004] * 49, seg=6, cap=False)
    band.data.materials.append(M['gold'])
    parts.append(band)
    for i in range(13):
        a = math.radians(-115 + 230 * i / 12)
        p = HC + Vector((math.sin(a) * 0.116, -math.cos(a) * 0.122 + 0.006, 0.078 + 0.02 * math.cos(a)))
        n = p - HC
        n.z *= 0.5
        n.normalize()
        if i % 2 == 0:
            parts += flower_mesh(p + n * 0.006, n, 0.011 + 0.004 * random.random(), M)
        for sgn in (-1, 1):
            d = Vector((math.cos(a) * sgn, math.sin(a) * sgn, 0.6)).normalized()
            parts.append(leaf_mesh(p, d, d.cross(n).normalized(), 0.032, M['leafgold'] if (i + sgn) % 3 else M['leafgreen']))
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.012, location=HC + Vector((0, -0.122, 0.10)))
    cj = bpy.context.active_object
    cj.scale = (0.8, 0.5, 1.4)
    cj.data.materials.append(M['gem'])
    parts.append(cj)
    cr = join(parts, 'Crown')
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return cr


def build_harp(M):
    Y = Vector((0, 1, 0))
    pillar = bez([(0.0, 0, -0.21), (-0.07, 0, -0.05), (-0.06, 0, 0.12), (0.0, 0, 0.23)], 18)
    neck = bez([(0.0, 0, 0.23), (0.09, 0, 0.30), (0.17, 0, 0.17), (0.27, 0, 0.17), (0.31, 0, 0.26), (0.27, 0, 0.29)], 30)
    box = bez([(0.0, 0, -0.21), (0.12, 0, -0.03), (0.27, 0, 0.17)], 16)
    wood = [
        sweep('pillar', pillar, [0.016] * 18, [0.013] * 18, seg=8, ups=[Y] * 18),
        sweep('neck', neck, [0.02 * (1 - 0.5 * (i / 29) ** 2) for i in range(30)], [0.012] * 30, seg=8, ups=[Y] * 30),
        sweep('box', box, [0.032 - 0.016 * (i / 15) for i in range(16)], [0.024 - 0.008 * (i / 15) for i in range(16)], seg=8, ups=[Y] * 16),
        sweep('foot', bez([(-0.02, 0, -0.21), (0.05, 0, -0.24), (0.08, 0, -0.2)], 8), [0.012] * 8, [0.01] * 8, seg=6, ups=[Y] * 8),
    ]
    for o in wood:
        o.data.materials.append(M['harpwood'])
    strings = []
    for i in range(1, 12):
        t = i / 12
        o = sweep('str', [neck[int(t * 25) + 2], box[int(t * 14) + 1]], [0.0014] * 2, [0.0014] * 2, seg=4, cap=False)
        o.data.materials.append(M['string'])
        strings.append(o)
    vines = []
    for curve, ph, out in ((pillar, 0, -1), (box, 1.5, 1)):
        pts = [p + Vector((math.cos(i * 0.9 + ph) * 0.02, math.sin(i * 0.9 + ph) * 0.02, 0)) for i, p in enumerate(curve)]
        o = sweep('vine', pts, [0.004] * len(pts), [0.004] * len(pts), seg=5)
        o.data.materials.append(M['leafgreen'])
        vines.append(o)
        for i in range(2, len(pts) - 1, 2):
            tan = (pts[i] - pts[i - 1]).normalized()
            d = (tan.cross(Y) * (out if i % 4 else -out) * 0.8 + tan * 0.6).normalized()
            vines.append(leaf_mesh(pts[i], d, d.cross(Y).normalized(), 0.045, M['leafgreen']))
    flowers = []
    for k in (4, 8, 13):
        p = pillar[k] + Vector((0, -0.018, 0))
        flowers += flower_mesh(p, Vector((0, -1, 0)), 0.013, M)
    h = join(wood + strings + vines + flowers, 'Harp')
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    grip = pillar[9]
    for vt in h.data.vertices:
        vt.co -= grip
    return h


# ───────────────────────── 骨架與權重 ─────────────────────────
def build_rig():
    arm = bpy.data.armatures.new('ElfRig')
    rig = link(bpy.data.objects.new('ElfRig', arm))
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    E = arm.edit_bones

    def B(name, h, t, parent=None, connect=False, deform=True):
        b = E.new(name)
        b.head, b.tail, b.use_deform = h, t, deform
        if parent:
            b.parent = E[parent]
            b.use_connect = connect

    B('root', (0, 0, 0), (0, 0.15, 0))
    B('hips', (0, 0, SK['pelvis_z']), (0, 0, SK['waist_z']), 'root')
    B('spine', (0, 0, SK['waist_z']), (0, 0, SK['chest_z']), 'hips', True)
    B('chest', (0, 0, SK['chest_z']), (0, 0.012, SK['neck_z']), 'spine', True)
    B('neck', (0, 0.012, SK['neck_z']), (0, 0.01, SK['head_z']), 'chest', True)
    B('head', (0, 0.01, SK['head_z']), (0, 0.01, HC.z + 0.125), 'neck', True)
    for s, S in ((1, 'L'), (-1, 'R')):
        sh, el, wr, tip = skv('shoulder', s), skv('elbow', s), skv('wrist', s), skv('hand_tip', s)
        B(f'shoulder.{S}', (s * 0.03, 0.01, SK['shoulder'][2] - 0.01), tuple(sh), 'chest')
        B(f'upper_arm.{S}', tuple(sh), tuple(el), f'shoulder.{S}', True)
        B(f'forearm.{S}', tuple(el), tuple(wr), f'upper_arm.{S}', True)
        B(f'hand.{S}', tuple(wr), tuple(tip), f'forearm.{S}', True)
        B(f'thigh.{S}', tuple(skv('hip', s, dz=0.005)), tuple(skv('knee', s)), 'hips')
        B(f'shin.{S}', tuple(skv('knee', s)), tuple(skv('ankle', s)), f'thigh.{S}', True)
        B(f'foot.{S}', tuple(skv('ankle', s)), tuple(skv('toe', s)), f'shin.{S}', True)
        B(f'sleeve.{S}', tuple(el.lerp(wr, 0.1) + Vector((s * 0.02, 0.0, 0))), tuple(wr + Vector((s * 0.03, 0.02, -0.06))), f'forearm.{S}')
    mid = (skv('wrist') + skv('hand_tip')) / 2 + Vector((0.0, -0.03, 0))
    B('prop_harp', tuple(mid), tuple(mid + Vector((0, -0.1, 0))), 'hand.L', deform=False)
    for name, x in (('hair_L', 0.075), ('hair_C', 0.0), ('hair_R', -0.075)):
        zs = [1.60, 1.30, 1.02, 0.78]
        prev = 'head'
        for i in range(3):
            B(f'{name}{i + 1}', (x * (1 + 0.6 * i), 0.12 + 0.03 * i, zs[i]), (x * (1 + 0.6 * (i + 1)), 0.12 + 0.03 * (i + 1), zs[i + 1]), prev, i > 0)
            prev = f'{name}{i + 1}'
    for name, a in (('skirt_F', 0), ('skirt_L', math.pi / 2), ('skirt_B', math.pi), ('skirt_R', -math.pi / 2)):
        d = Vector((math.sin(a), -math.cos(a), 0))
        p0 = d * 0.12 + Vector((0, 0, 0.98))
        p1 = d * 0.27 + Vector((0, 0, 0.52))
        p2 = d * (0.52 if a == math.pi else 0.45) + Vector((0, 0, 0.04))
        B(f'{name}1', p0, p1, 'hips')
        B(f'{name}2', p1, p2, f'{name}1', True)
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig


def skin_all(rig, objs):
    bones = rig.data.bones

    def seg_d(p, b):
        h, t = b.head_local, b.tail_local
        _, f = intersect_point_line(p, h, t)
        f = min(1, max(0, f))
        return (p - h.lerp(t, f)).length

    def inv(p, cands, eps=0.01, power=4):
        return {n: m / (seg_d(p, bones[n]) + eps) ** power for n, m in cands.items()}

    SIDE = ('L', 'R')
    body_c = {n: 1.0 for n in ['hips', 'spine', 'chest', 'neck', 'head'] + [f'{b}.{s}' for s in SIDE for b in ('shoulder', 'upper_arm', 'forearm', 'hand', 'thigh', 'shin', 'foot')]}

    def hand_w(p):  # 手掌與手指跟著手骨，手腕處與前臂混合
        s = 'L' if p.x > 0 else 'R'
        h = bones[f'hand.{s}']
        _, f = intersect_point_line(p, h.head_local, h.tail_local)
        k = min(1.0, max(0.0, f / 0.25))
        return {f'hand.{s}': 0.3 + 0.7 * k, f'forearm.{s}': 0.7 * (1 - k)}

    def sleeve(p):
        s = 'L' if p.x > 0 else 'R'
        return inv(p, {f'upper_arm.{s}': 1, f'forearm.{s}': 1, f'sleeve.{s}': 1.3, f'shoulder.{s}': 0.4})

    def hair(p):
        if p.z > HC.z - 0.055:
            return {'head': 1}
        if p.y < 0.03:
            k = min(1, (HC.z - 0.055 - p.z) / 0.3)
            return {'head': 1 - 0.6 * k, 'chest': 0.6 * k}
        ws = inv(p, {f'{c}{i}': 1 for c in ('hair_L', 'hair_C', 'hair_R') for i in (1, 2, 3)}, eps=0.02)
        ws['head'] = (max(0.0, p.z - (HC.z - 0.165)) / 0.11) ** 2 * 1e5
        return ws

    def skirt(p):
        t = min(1, max(0, (SKIRT_TOP - p.z) / SKIRT_LEN))
        if t < 0.08:
            return {'hips': 1}
        ws = inv(p, {f'{c}{i}': 1 for c in ('skirt_F', 'skirt_L', 'skirt_B', 'skirt_R') for i in (1, 2)}, eps=0.03, power=3)
        tot = sum(ws.values())
        hipw = max(0, 1 - t / 0.38)  # 貼身的臀部段跟骨盆走
        out = {k: v / tot * (1 - hipw) * 0.75 for k, v in ws.items()}
        side = 'L' if p.x > 0 else 'R'
        th = 0.25 * (1 - hipw) * min(1, max(0, -p.y / (abs(p.x) + abs(p.y) + 1e-4) + 0.3))
        out[f'thigh.{side}'] = th
        out['hips'] = hipw + max(0, (1 - hipw) * 0.25 - th)
        return out

    def gold(p):  # 金邊：腰帶以下跟裙子、胸前跟胸衣、上臂環跟手臂
        if abs(p.x) > 0.17 and p.z > 1.2:
            return sleeve(p)
        if p.z > SKIRT_TOP + 0.035:
            return inv(p, {'hips': 1, 'spine': 1, 'chest': 1, 'neck': 0.5})
        return skirt(p)

    rules = {
        'Body': lambda p: inv(p, body_c),
        'Hands': hand_w,
        'Shoes': lambda p: inv(p, {f'{b}.{s}': 1 for s in SIDE for b in ('shin', 'foot')}),
        'Bodice': lambda p: inv(p, {'hips': 1, 'spine': 1, 'chest': 1, 'neck': 0.5}),
        'Gem': lambda p: {'chest': 1},
        'Head': lambda p: {'head': 1},
        'Ears': lambda p: {'head': 1},
        'Crown': lambda p: {'head': 1},
        'Sleeves': sleeve,
        'Hair': hair,
        'SkirtInner': skirt,
        'Overskirt': skirt,
        'GoldTrim': gold,
    }
    for ob in objs:
        rule = rules[ob.name]
        vgs = {}
        for v in ob.data.vertices:
            items = sorted(rule(v.co).items(), key=lambda kv: -kv[1])[:4]
            tot = sum(w for _, w in items) or 1
            for name, w in items:
                if w / tot < 0.01:
                    continue
                if name not in vgs:
                    vgs[name] = ob.vertex_groups.new(name=name)
                vgs[name].add([v.index], w / tot, 'REPLACE')
        ob.parent = rig
        mod = ob.modifiers.new('Armature', 'ARMATURE')
        mod.object = rig


# ───────────────────────── 動畫 ─────────────────────────
X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
S, C, TAU = math.sin, math.cos, 2 * math.pi


def build_actions(rig):
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    # 頭髮 / 裙擺 / 袖子 / 道具骨不打關鍵影格：交給 three.js 的彈簧次級動畫
    keyed = [b.name for b in rig.data.bones if not b.name.startswith(('hair_', 'skirt_', 'sleeve', 'prop_'))]

    def R(bname, *rots):
        """以「世界軸 + 角度」描述旋轉，轉換成骨頭區域空間的四元數"""
        Bm = rig.data.bones[bname].matrix_local.to_3x3().inverted()
        q = Quaternion()
        for ax, deg in rots:
            q = Quaternion(Bm @ ax, math.radians(deg)) @ q
        return q

    def aim_chain(P, names, targets, k=1.0):
        """把一串骨頭（父 → 子）依序對準世界座標目標點，回傳各骨的區域四元數。
        假設鏈的起點之上（肩、胸）沒有旋轉。k 為 0~1 的混合比例。"""
        bones = [rig.data.bones[n] for n in names]
        parent_world = bones[0].parent.matrix_local.to_quaternion()
        parent_rest = bones[0].parent.matrix_local.to_quaternion()
        pos = bones[0].head_local.copy()
        for b, tgt in zip(bones, targets):
            rel = parent_rest.inverted() @ b.matrix_local.to_quaternion()
            base = parent_world @ rel
            d0 = base @ Vector((0, 1, 0))
            d1 = (Vector(tgt) - pos).normalized()
            world = d0.rotation_difference(d1) @ base
            q = base.inverted() @ world
            P[b.name].rotation_quaternion = Quaternion().slerp(q, k)
            # 子骨以混合後的姿勢為父
            world = base @ P[b.name].rotation_quaternion
            pos = pos + (world @ Vector((0, 1, 0))) * b.length
            parent_world, parent_rest = world, b.matrix_local.to_quaternion()

    def make(name, length, fn, step):
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
            for n in keyed:
                P[n].keyframe_insert('rotation_quaternion', frame=f)
            P['root'].keyframe_insert('location', frame=f)
        return act

    def idle(t, P, R):
        P['upper_arm.L'].rotation_quaternion = R('upper_arm.L', (Y, 6 + 1.5 * S(t * TAU)), (X, -4))
        P['upper_arm.R'].rotation_quaternion = R('upper_arm.R', (Y, -6 - 1.5 * S(t * TAU)), (X, -4))
        P['forearm.L'].rotation_quaternion = R('forearm.L', (X, -14))
        P['forearm.R'].rotation_quaternion = R('forearm.R', (X, -14))
        P['chest'].rotation_quaternion = R('chest', (X, 2 * S(t * TAU)))
        P['hips'].rotation_quaternion = R('hips', (Y, 1.5 * S(t * TAU)), (Z, 3 * S(t * TAU)))
        P['head'].rotation_quaternion = R('head', (Y, 4 * S(t * TAU + 1)), (Z, 6 * S(t * TAU)))
        P['root'].location = Vector((0, 0, 0.006 * S(t * TAU * 2)))

    def gait(amp_leg, amp_arm, knee, lean, bob):
        def f(t, P, R):
            a, b = S(t * TAU), S(t * TAU + math.pi)
            # 長裙：腿往後擺的幅度要小，否則腳會穿出裙襬
            P['thigh.L'].rotation_quaternion = R('thigh.L', (X, -amp_leg * (a if a > 0 else a * 0.4)))
            P['thigh.R'].rotation_quaternion = R('thigh.R', (X, -amp_leg * (b if b > 0 else b * 0.4)))
            P['shin.L'].rotation_quaternion = R('shin.L', (X, knee * max(0, S(t * TAU - 1.2))))
            P['shin.R'].rotation_quaternion = R('shin.R', (X, knee * max(0, S(t * TAU + math.pi - 1.2))))
            P['upper_arm.L'].rotation_quaternion = R('upper_arm.L', (Y, 5), (X, amp_arm * a))
            P['upper_arm.R'].rotation_quaternion = R('upper_arm.R', (Y, -5), (X, amp_arm * b))
            P['forearm.L'].rotation_quaternion = R('forearm.L', (X, -20 - amp_arm * 0.8 * max(0, -a)))
            P['forearm.R'].rotation_quaternion = R('forearm.R', (X, -20 - amp_arm * 0.8 * max(0, -b)))
            P['hips'].rotation_quaternion = R('hips', (Z, 6 * a), (X, lean * 0.3))
            P['spine'].rotation_quaternion = R('spine', (Z, -5 * a), (X, lean * 0.4))
            P['chest'].rotation_quaternion = R('chest', (Z, -4 * a), (X, lean * 0.3))
            P['head'].rotation_quaternion = R('head', (Z, 3 * a), (X, -lean * 0.6))
            P['root'].location = Vector((0, 0, bob * abs(C(t * TAU))))
        return f

    def play(t, P, R):
        # 彈豎琴：手肘在胸部外側，前臂往前伸到胸前（不穿過胸部）。左手扶琴，右手撥弦
        w = S(t * TAU * 4)
        aim_chain(P, ['upper_arm.L', 'forearm.L', 'hand.L'],
                  [(0.215, -0.085, 1.15), (0.10, -0.25, 1.20), (0.06, -0.30, 1.21)])
        aim_chain(P, ['upper_arm.R', 'forearm.R', 'hand.R'],
                  [(-0.215, -0.08, 1.15 + 0.008 * w), (-0.07, -0.27 + 0.01 * w, 1.24 + 0.02 * w), (-0.03, -0.31, 1.235 + 0.025 * S(t * TAU * 4 + 0.8))])
        P['head'].rotation_quaternion = R('head', (X, 12), (Z, 8 * S(t * TAU)), (Y, 5 * S(t * TAU)))
        P['chest'].rotation_quaternion = R('chest', (Z, 3 * S(t * TAU)), (X, 3))
        P['hips'].rotation_quaternion = R('hips', (Y, 2 * S(t * TAU)))

    def cast(t, P, R):
        # 魔法凝視：手肘在胸側往外，雙手在臉前比愛心
        k = min(1, t * 3)
        k = k * k * (3 - 2 * k)
        for s_, S_ in ((1, 'L'), (-1, 'R')):
            aim_chain(P, [f'upper_arm.{S_}', f'forearm.{S_}', f'hand.{S_}'],
                      [(s_ * 0.215, -0.10, 1.25), (s_ * 0.045, -0.20, 1.47), (s_ * 0.004, -0.215, 1.545)], k)
        P['head'].rotation_quaternion = R('head', (Z, 10 * k), (X, -4 * k))

    def strike(t, P, R):
        k = S(min(1, t * 1.6) * math.pi * 0.5)
        P['upper_arm.R'].rotation_quaternion = R('upper_arm.R', (Y, -40 * k), (X, -80 * k))
        P['forearm.R'].rotation_quaternion = R('forearm.R', (X, -10))
        P['hand.R'].rotation_quaternion = R('hand.R', (X, -50 * k))
        P['upper_arm.L'].rotation_quaternion = R('upper_arm.L', (Y, 10), (X, 25 * k))
        P['spine'].rotation_quaternion = R('spine', (Z, -14 * k))
        P['chest'].rotation_quaternion = R('chest', (Z, -10 * k), (X, 6 * k))

    def capture(t, P, R):
        k = S(t * TAU * 2)
        P['spine'].rotation_quaternion = R('spine', (X, 14))
        P['chest'].rotation_quaternion = R('chest', (X, 10))
        P['head'].rotation_quaternion = R('head', (X, 14))
        P['upper_arm.L'].rotation_quaternion = R('upper_arm.L', (Y, 22), (X, -60 + 18 * k))
        P['upper_arm.R'].rotation_quaternion = R('upper_arm.R', (Y, -22), (X, -60 - 18 * k))
        P['forearm.L'].rotation_quaternion = R('forearm.L', (X, -40 - 15 * k))
        P['forearm.R'].rotation_quaternion = R('forearm.R', (X, -40 + 15 * k))
        for s in ('L', 'R'):
            P[f'thigh.{s}'].rotation_quaternion = R(f'thigh.{s}', (X, -12))
            P[f'shin.{s}'].rotation_quaternion = R(f'shin.{s}', (X, 20))
        P['root'].location = Vector((0, 0, -0.04))

    def victory(t, P, R):
        hop = max(0, S(t * TAU))
        P['upper_arm.L'].rotation_quaternion = R('upper_arm.L', (Y, -95 - 15 * hop), (X, -20))
        P['upper_arm.R'].rotation_quaternion = R('upper_arm.R', (Y, 95 + 15 * hop), (X, -20))
        P['forearm.L'].rotation_quaternion = R('forearm.L', (X, -25))
        P['forearm.R'].rotation_quaternion = R('forearm.R', (X, -25))
        P['head'].rotation_quaternion = R('head', (X, -14), (Z, 8 * S(t * TAU)))
        P['chest'].rotation_quaternion = R('chest', (X, -6))
        for s in ('L', 'R'):
            P[f'shin.{s}'].rotation_quaternion = R(f'shin.{s}', (X, 30 * hop))
        P['root'].location = Vector((0, 0, 0.12 * hop))

    def stunned(t, P, R):
        P['upper_arm.L'].rotation_quaternion = R('upper_arm.L', (Y, -25), (X, -15))
        P['upper_arm.R'].rotation_quaternion = R('upper_arm.R', (Y, 25), (X, -15))
        P['forearm.L'].rotation_quaternion = R('forearm.L', (X, -30))
        P['forearm.R'].rotation_quaternion = R('forearm.R', (X, -30))
        P['head'].rotation_quaternion = R('head', (Z, 16 * S(t * TAU)), (X, 8))
        P['spine'].rotation_quaternion = R('spine', (Z, 6 * S(t * TAU + 0.5)))
        P['hips'].rotation_quaternion = R('hips', (Z, 4 * S(t * TAU + 1)))

    make('Idle', 60, idle, 5)
    make('Walk', 32, gait(24, 18, 40, 4, 0.025), 2)
    make('Run', 20, gait(40, 34, 50, 14, 0.06), 2)
    make('Play', 40, play, 2)
    make('Cast', 24, cast, 2)
    make('Strike', 14, strike, 1)
    make('Capture', 16, capture, 2)
    make('Victory', 48, victory, 3)
    make('Stunned', 30, stunned, 3)
    rig.animation_data.action = bpy.data.actions['Idle']
    for pb in rig.pose.bones:
        pb.rotation_quaternion = Quaternion()
        pb.location = Vector()


# ───────────────────────── 組裝 / LOD / 匯出 ─────────────────────────
def materials():
    return {
        'skin': pbr('M_Skin', (0.99, 0.84, 0.75), 0.55),
        'face': pbr('M_Face', (1, 1, 1), 0.55, img=face_texture()),
        'hair': pbr('M_Hair', (1, 1, 1), 0.45, img=hair_texture()),
        'dress': pbr('M_Dress', (1, 1, 1), 0.6, img=skirt_texture()),
        'over': pbr('M_Overskirt', (1, 1, 1), 0.55, img=overskirt_texture()),
        'bodice': pbr('M_Bodice', (0.97, 0.95, 0.89), 0.6),
        'gold': pbr('M_Gold', (0.95, 0.74, 0.32), 0.3, metal=1.0),
        'gem': pbr('M_Gem', (0.1, 0.75, 0.35), 0.1, emis=((0.1, 0.8, 0.3), 0.6)),
        'sheer': pbr('M_Sheer', (0.98, 0.97, 0.93), 0.4, alpha=0.45),
        'petal': pbr('M_Petal', (1.0, 0.98, 0.95), 0.5),
        'leafgold': pbr('M_LeafGold', (0.9, 0.72, 0.3), 0.35, metal=0.8),
        'leafgreen': pbr('M_LeafGreen', (0.3, 0.6, 0.32), 0.5),
        'shoe': pbr('M_Shoe', (0.95, 0.93, 0.88), 0.35),
        'harpwood': pbr('M_HarpWood', (1, 1, 1), 0.35, metal=0.7, img=harp_texture()),
        'string': pbr('M_String', (1.0, 0.96, 0.82), 0.2, metal=1.0, emis=((1, 0.9, 0.6), 0.3)),
    }


def strip_hidden_body(body):
    """刪除被衣服完全蓋住的身體面（長裙內的腿與骨盆、胸衣下的軀幹），減少頂點並避免動畫時皮膚穿出衣服。
    胸衣與鞋子已經從完整的身體複製出來，所以這裡刪除不影響它們。"""
    sh, el = Vector(SK['shoulder']), Vector(SK['elbow'])
    bm = bmesh.new()
    bm.from_mesh(body.data)
    kill = []
    for f in bm.faces:
        c = f.calc_center_median()
        ax = abs(c.x)
        cm = Vector((ax, c.y, c.z))
        _, fr = intersect_point_line(cm, sh, el)
        d_arm = (cm - sh.lerp(el, min(1, max(0, fr)))).length
        in_skirt = 0.15 < c.z < SKIRT_TOP - 0.03 and ax < 0.2
        under_bodice = SKIRT_TOP - 0.04 < c.z < BUST['z'] + 0.02 and ax < 0.15 and d_arm > 0.06
        if in_skirt or under_bodice:
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(body.data)
    bm.free()


def save(tag):
    os.makedirs(OUT_BLEND, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_BLEND, 'elf.blend'))
    print('saved', tag)


def stage_model():
    reset()
    M = materials()
    body = build_body(M)
    parts = [body, build_head(M), build_hair(M), build_ears(M), build_crown(M), build_hands(M)] + build_dress(M, body)
    strip_hidden_body(body)
    harp = build_harp(M)
    harp.location = (0.9, 0, 1.0)
    save('model')
    return parts, harp


def stage_rig(parts):
    rig = build_rig()
    skin_all(rig, parts)
    # join 以作用中物件的 UV 圖層為準；沒有 UV 的網格（Body 由 Skin 修改器產生）要先補上，否則全部 UV 會被丟掉
    for o in parts:
        if not o.data.uv_layers:
            o.data.uv_layers.new(name='UVMap')
        o.data.uv_layers[0].name = 'UVMap'
    lod0 = join(parts, 'ElfMesh_LOD0')
    # LOD1：複製後減面（保留頂點群組）
    bpy.ops.object.select_all(action='DESELECT')
    lod0.select_set(True)
    bpy.context.view_layer.objects.active = lod0
    bpy.ops.object.duplicate()
    lod1 = bpy.context.active_object
    lod1.name = lod1.data.name = 'ElfMesh_LOD1'
    dec = lod1.modifiers.new('Dec', 'DECIMATE')
    dec.ratio = 0.3
    bpy.ops.object.modifier_move_to_index(modifier='Dec', index=0)
    bpy.ops.object.modifier_apply(modifier='Dec')
    build_actions(rig)
    save('rig')
    return rig, lod0, lod1


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
        export_image_format='WEBP', export_image_quality=92, export_def_bones=False, export_force_sampling=True,
        export_optimize_animation_size=True,
        # EXT_meshopt_compression：three.js 以 MeshoptDecoder 解碼（瀏覽器與 Node 測試都可用，不需 Worker）
        export_meshopt_compression_enable=True,
    )
    bpy.ops.object.select_all(action='DESELECT')
    loc = harp.location.copy()
    harp.location = (0, 0, 0)
    harp.select_set(True)
    bpy.context.view_layer.objects.active = harp
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT_GLB, 'harp.glb'), export_format='GLB', use_selection=True,
                              export_animations=False, export_yup=True, export_image_format='WEBP', export_image_quality=92,
                              export_meshopt_compression_enable=True)
    harp.location = loc
    print('exported to', OUT_GLB)


def main():
    parts, harp = stage_model()
    rig, lod0, lod1 = stage_rig(parts)
    export(rig, [lod0, lod1], harp)
    save('final')


if __name__ == '__main__' or __name__ == '<run_path>' or __name__ == 'builtins':
    main()
