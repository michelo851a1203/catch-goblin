"""
Catch Goblin — 紫晶精靈（小提琴刺客）：Meshy.ai Mixamo 綁骨模型 → 正規化 / 程序化動作 / 道具 / LOD / 匯出

來源（Meshy.ai 產出，放在 repo 外層的 assets/assets_紫髮法師/）：
    Meshy_AI_Elven_Maiden_Rigged_*_animated_mixamo_All_animation.glb   角色（Mixamo 骨架 + 權重 + Walking / Running）
    Elven_Violin.glb                                                   小提琴（64 萬頂點，減面後使用）

用法：
    blender -b -P tools/blender/build_violinist.py
    （可用環境變數 VIOLINIST_ASSET_DIR 指定素材資料夾；VIOLINIST_PREVIEW=1 時另外輸出各動作的預覽圖）

輸出：
    public/models/violinist/violinist.glb   LOD0 + LOD1 共用骨架、小提琴與琴弓（掛在 prop_violin / prop_bow 骨）、12 個動作
    tools/blender/out/violinist.blend

流程：
  1. 匯入 Mixamo GLB、套用 0.01 縮放（cm → m）、骨頭去掉 "mixamorig:" 前綴、腳底對齊 y=0
  2. 量測 Walking / Running 的腳底速度（遊戲依實際移動速度調整播放速率，見 VIOLINIST_GAIT_REF）
  3. 新增道具骨 prop_violin（左手）/ prop_bow（右手），小提琴減面後與程序化琴弓以骨頭父子關係掛上
  4. 以「世界軸 + 相對 rest」與兩骨 IK 產生其餘動作：拉琴、刺客之眼、衝鋒前搖 / 突刺 / 收招、捕獲、勝利、暈眩
     道具骨每格依手的位置重新擺放（拉琴時琴弓永遠通過琴橋附近的接觸點）
  5. LOD1 減面、貼圖縮小為 WebP、匯出 GLB（EXT_meshopt_compression）
"""
import bpy, bmesh, math, os, shutil, subprocess
import numpy as np
from mathutils import Vector, Quaternion, Matrix

try:
    REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
except NameError:
    REPO = '/Users/michaelho/main/project/2026-10-20-side-hustle/goblin-game'
ASSET_DIR = os.environ.get('VIOLINIST_ASSET_DIR', os.path.join(os.path.dirname(REPO), 'assets', 'assets_紫髮法師'))
SRC_CHAR = 'Meshy_AI_Elven_Maiden_Rigged_20261107_animated_mixamo_All_animation.glb'
SRC_VIOLIN = 'Elven_Violin.glb'
OUT_GLB = os.path.join(REPO, 'public', 'models', 'violinist')
OUT_BLEND = os.path.join(REPO, 'tools', 'blender', 'out')
PREVIEW_DIR = os.environ.get('VIOLINIST_PREVIEW_DIR', os.path.join(OUT_BLEND, 'violinist_preview'))

TEX_SIZE = 2048
# 桌機放大看時使用的原尺寸色彩貼圖（另存成獨立 WebP，遊戲在非低階裝置上延遲載入替換）
HIRES_SIZE = 4096
HIRES_QUALITY = 90
LOD1_RATIO = 0.3
# Meshy 匯出為三角形湯（每個三角形各自擁有頂點）：焊接完全重疊的頂點
WELD_DIST = 1e-5
# 頭部（含臉、耳朵）細分一層：Meshy 的頭只有約 3300 面，下巴 / 臉頰 / 鼻樑的輪廓有稜角
HEAD_SUBDIV_WEIGHT = 0.3  # Head 骨權重超過此值的面才細分
HEAD_SUBDIV_SHARP = math.cos(math.radians(50))  # 兩端法線夾角超過 50° 的邊不彎曲
SMOOTH_ANGLE = 60  # 超過此角度的邊保留硬邊（盔甲稜角、飾品）
# 臉部法線：往頭部橢球的法線混合，讓 cel shading 的明暗交界在臉上是乾淨的大塊形狀
FACE_CENTER = Vector((0.0, -0.035, 1.465))
FACE_RADII = Vector((0.09, 0.13, 0.12))
FACE_BLEND = 0.85
FACE_EXTENT = (0.082, 0.1)  # 遮罩橢圓（x 半寬、z 半高），中心同 FACE_CENTER
VIOLIN_LEN = 0.48  # 角色手臂偏短（動漫比例），琴身略小於真實的 0.59 m
VIOLIN_TRIS = 9000
VIOLIN_GRIP = 0.70  # 左手握在琴頸：由琴尾往上 70% 處
BOW_LEN = 0.56
FPS = 24
SINK = 0.006

X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
Sn, Cs, TAU = math.sin, math.cos, 2 * math.pi
FWD = Vector((0, -1, 0))  # 角色面向 Blender -Y（glTF +Z）


def smooth(k):
    k = max(0.0, min(1.0, k))
    return k * k * (3 - 2 * k)


def lerp(a, b, k):
    return a + (b - a) * k


def vlerp(a, b, k):
    return Vector(a).lerp(Vector(b), k)


# ───────────────────────── 1. 載入 / 正規化 ─────────────────────────
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def channel_fcurves(act):
    """Blender 4.4+ 的分層動作：取出第一個 slot 的 F-Curve"""
    try:
        return list(act.layers[0].strips[0].channelbags[0].fcurves)
    except (AttributeError, IndexError):
        return list(act.fcurves)


def load_char():
    bpy.ops.import_scene.gltf(filepath=os.path.join(ASSET_DIR, SRC_CHAR))
    for o in list(bpy.data.objects):
        if o.type == 'MESH' and o.parent is None:
            bpy.data.objects.remove(o, do_unlink=True)  # Meshy 附帶的 Icosphere
    rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    me = next(o for o in bpy.data.objects if o.type == 'MESH')
    rig.name, rig.data.name = 'VioletRig', 'VioletRig'
    me.name = me.data.name = 'VioletMesh_LOD0'
    sc = bpy.context.scene
    sc.render.fps, sc.render.fps_base = FPS, 1.0
    rig.animation_data.action = None
    # 套用 0.01 縮放：骨架、網格一起；動作中的位移軌道（cm）要手動縮放
    bpy.ops.object.select_all(action='DESELECT')
    for o in (rig, me):
        o.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for act in bpy.data.actions:
        for fc in channel_fcurves(act):
            if fc.data_path.endswith('location'):
                for k in fc.keyframe_points:
                    k.co[1] *= 0.01
                    k.handle_left[1] *= 0.01
                    k.handle_right[1] *= 0.01
    for b in rig.data.bones:
        b.name = b.name.replace('mixamorig:', '')
    for act in bpy.data.actions:
        for fc in channel_fcurves(act):
            fc.data_path = fc.data_path.replace('mixamorig:', '')
    walk, run = bpy.data.actions['Walking'], bpy.data.actions['Running']
    walk.name, run.name = 'Walk', 'Run'
    for a in (walk, run):
        a.use_fake_user = True
    return rig, me


def weld_and_smooth(me):
    """Meshy 的網格是三角形湯：6 萬頂點幾乎全是重複點、每個三角形互不相連。
    不焊接的話法線是一面一面的（臉像多面體）、描邊會從三角形的縫隙漏出來，LOD1 減面也會破碎。
    焊接後清掉匯入的自訂法線，依角度重建平滑法線"""
    n0 = len(me.data.vertices)
    bm = bmesh.new()
    bm.from_mesh(me.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=WELD_DIST)
    # 頭部細分：只選 Head 權重高的面，新頂點的權重 / UV 由 bmesh 內插
    dl = bm.verts.layers.deform.active
    hg = me.vertex_groups['Head'].index
    head = {v for v in bm.verts if v[dl].get(hg, 0.0) > HEAD_SUBDIV_WEIGHT}
    edges = list({e for f in bm.faces if all(v in head for v in f.verts) for e in f.edges})
    nf = len(bm.faces)
    bm.normal_update()
    # subdivide_edges 之後所有 BMVert 物件都會重建，原始頂點改以座標辨識（原始頂點不會移動）
    key = lambda co: (round(co.x, 6), round(co.y, 6), round(co.z, 6))
    nrm = {key(v.co): v.normal.copy() for v in head}
    # 平面細分（bmesh 的 smooth 參數沿頂點法線推點，在這份網格的非流形處會把面推穿、臉上破洞），
    # 新的邊中點再自行以兩端法線的三次 Hermite 曲線放到曲面上（PN-triangle 的作法）
    orig = {key(v.co) for v in bm.verts}
    bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True)
    moved = 0
    for v in [v for v in bm.verts if key(v.co) not in orig]:
        ends = [u for u in (e.other_vert(v) for e in v.link_edges) if key(u.co) in nrm]
        pair = next(((a, b) for i, a in enumerate(ends) for b in ends[i + 1:] if ((a.co + b.co) / 2 - v.co).length < 1e-6), None)
        if not pair:
            continue
        a, b = pair
        na, nb = nrm[key(a.co)], nrm[key(b.co)]
        if na.dot(nb) < HEAD_SUBDIV_SHARP:
            continue  # 硬邊（耳尖、飾品稜角）維持直線
        d = b.co - a.co
        ta, tb = d - na * na.dot(d), d - nb * nb.dot(d)
        off = (ta - tb) / 8
        lim = d.length * 0.2
        if off.length > lim:
            off *= lim / off.length
        v.co += off
        moved += 1
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    print(f'[violinist] head subdivide {nf} -> {len(bm.faces)} faces, curved {moved} midpoints')
    bm.to_mesh(me.data)
    bm.free()
    bpy.ops.object.select_all(action='DESELECT')
    me.select_set(True)
    bpy.context.view_layer.objects.active = me
    if me.data.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(SMOOTH_ANGLE))
    print(f'[violinist] weld {n0} -> {len(me.data.vertices)} verts')


def remove_inner_face_layer(me):
    """Meshy 的臉是雙層殼：外層皮膚後方 4–7 mm 還有一層朝內的面。內層永遠被外層蓋住看不到，
    但描邊（OutlineEffect 沿法線外擴的背面殼）會從髮際線的縫隙透出來，在額頭上留下咖啡色碎片。
    刪除臉部範圍內「朝後、且正前方 12 mm 內有朝前的外層皮膚」的面"""
    from mathutils.bvhtree import BVHTree
    bm = bmesh.new()
    bm.from_mesh(me.data)
    bm.normal_update()
    dl = bm.verts.layers.deform.active
    hg = me.vertex_groups['Head'].index
    tree = BVHTree.FromBMesh(bm)
    c0, (ex, ez) = FACE_CENTER, FACE_EXTENT
    kill = []
    for f in bm.faces:
        if f.normal.y < 0.2 or any(v[dl].get(hg, 0.0) <= 0.5 for v in f.verts):
            continue
        c = f.calc_center_median()
        if c.y > c0.y - 0.015 or ((c.x - c0.x) / ex) ** 2 + ((c.z - c0.z) / ez) ** 2 > 1.21:
            continue
        loc, n, _, _ = tree.ray_cast(c + Vector((0, -1e-4, 0)), Vector((0, -1, 0)), 0.012)
        if loc is not None and n.y < 0:
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(me.data)
    bm.free()
    print(f'[violinist] removed {len(kill)} hidden inner face-layer faces')


def smoothstep_np(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def face_normals(me):
    """臉部遮罩 + 橢球法線（動漫角色常用的臉部法線處理）：
    臉上原始法線跟著五官起伏，cel shading 的明暗交界會變成鼻翼 / 眼窩旁破碎的色塊；
    改用頭部橢球的法線後，臉上只剩隨光源方向移動的乾淨大塊陰影。
    遮罩同時存成頂點屬性 _FACEMASK，遊戲的 shader 以此柔化臉上的陰影、略過自身陰影貼圖"""
    m = me.data
    n = len(m.vertices)
    co = np.empty(n * 3)
    m.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    hg = me.vertex_groups['Head'].index
    hw = np.zeros(n)
    for v in m.vertices:
        for g in v.groups:
            if g.group == hg:
                hw[v.index] = g.weight
    # 取每個頂點的平均 UV 對色彩貼圖取樣：膚色頂點（頭髮 / 瀏海是紫色，不屬於臉）
    img = next(nd.image for nd in m.materials[0].node_tree.nodes if nd.type == 'TEX_IMAGE' and nd.image and 'metallic' not in nd.image.name and 'rough' not in nd.image.name)
    W, H = img.size
    px = np.empty(W * H * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(H, W, 4)
    uv = np.zeros((n, 2))
    cnt = np.zeros(n)
    luv = np.empty(len(m.loops) * 2)
    m.uv_layers.active.data.foreach_get('uv', luv)
    lv = np.empty(len(m.loops), dtype=np.int64)
    m.loops.foreach_get('vertex_index', lv)
    np.add.at(uv, lv, luv.reshape(-1, 2))
    np.add.at(cnt, lv, 1)
    uv /= np.maximum(cnt, 1)[:, None]
    c = px[np.clip((uv[:, 1] * H).astype(int), 0, H - 1), np.clip((uv[:, 0] * W).astype(int), 0, W - 1), :3]
    skin = (c[:, 0] > c[:, 1]) & (c[:, 1] > c[:, 2] - 0.02) & (c[:, 0] - c[:, 2] > 0.05) & (c[:, 0] > 0.5)
    ctr = np.array(FACE_CENTER)
    # 臉部範圍：頭骨權重、正面、臉部橢圓內；眼睛 / 嘴巴（非膚色）以「貼在膚色表面上」納入
    u = np.sqrt(((co[:, 0] - ctr[0]) / FACE_EXTENT[0]) ** 2 + ((co[:, 2] - ctr[2]) / FACE_EXTENT[1]) ** 2)
    region = (hw > 0.5) & (u < 1.05) & (co[:, 1] < ctr[1] - 0.015)
    from mathutils.kdtree import KDTree
    sk = np.nonzero(region & skin)[0]
    kd = KDTree(len(sk))
    for i in sk:
        kd.insert(Vector(co[i]), int(i))
    kd.balance()
    on_face = np.zeros(n, dtype=bool)
    for i in np.nonzero(region)[0]:
        _, _, d = kd.find(Vector(co[i]))
        on_face[i] = d is not None and d < 0.004
    w = on_face * (1 - smoothstep_np(0.75, 1.05, u)) * smoothstep_np(ctr[1] - 0.015, ctr[1] - 0.06, co[:, 1])
    # 在網格上平滑幾次，去掉零星的斑點、讓邊緣漸變
    ev = np.empty(len(m.edges) * 2, dtype=np.int64)
    m.edges.foreach_get('vertices', ev)
    ev = ev.reshape(-1, 2)
    for _ in range(2):
        acc = w.copy()
        deg = np.ones(n)
        np.add.at(acc, ev[:, 0], w[ev[:, 1]])
        np.add.at(acc, ev[:, 1], w[ev[:, 0]])
        np.add.at(deg, ev[:, 0], 1)
        np.add.at(deg, ev[:, 1], 1)
        w = np.where(region, acc / deg, 0.0)
    w = np.clip(w * 1.3, 0, 1)
    attr = m.attributes.get('_FACEMASK') or m.attributes.new('_FACEMASK', 'FLOAT', 'POINT')
    attr.data.foreach_set('value', w.astype(np.float32))
    # 每個角的法線：在原始（依角度平滑）法線與橢球法線間依遮罩混合
    cn = np.empty(len(m.loops) * 3)
    m.corner_normals.foreach_get('vector', cn)
    cn = cn.reshape(-1, 3)
    r2 = np.array(FACE_RADII) ** 2
    el = (co - ctr) / r2
    el /= np.linalg.norm(el, axis=1, keepdims=True)
    k = (w * FACE_BLEND)[lv][:, None]
    out = cn * (1 - k) + el[lv] * k
    out /= np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-8)
    m.normals_split_custom_set([tuple(v) for v in out])
    print(f'[violinist] face mask {int((w > 0.5).sum())} verts (>0.5), {int((w > 0).sum())} verts (>0)')


def foot_verts(me):
    """腳 / 腳尖權重高的頂點（接地判斷用，不受裙擺影響）"""
    idx = [vg.index for vg in me.vertex_groups if vg.name.endswith(('Foot', 'ToeBase'))]
    out = []
    for v in me.data.vertices:
        if sum(g.weight for g in v.groups if g.group in idx) > 0.5:
            out.append(v.index)
    return np.array(out)


def eval_coords(me, idx=None):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = me.evaluated_get(dg)
    m = ev.to_mesh()
    co = np.empty(len(m.vertices) * 3)
    m.vertices.foreach_get('co', co)
    ev.to_mesh_clear()
    co = co.reshape(-1, 3)
    return co if idx is None else co[idx]


def ground(rig, me, fidx):
    """把骨架往下移，讓 Walking 動作中最低的腳底略陷入地面"""
    sc = bpy.context.scene
    rig.animation_data.action = bpy.data.actions['Walk']
    lows = []
    for f in range(0, 25, 2):
        sc.frame_set(f)
        lows.append(eval_coords(me, fidx)[:, 2].min())
    rig.animation_data.action = None
    dz = -float(np.mean(lows)) - SINK
    rig.location.z += dz
    me.location.z += dz
    bpy.ops.object.select_all(action='DESELECT')
    for o in (rig, me):
        o.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    print(f'[violinist] ground shift {dz:.3f} m')


def measure_gait(rig, act_name, frames):
    """支撐腳相對骨盆往後移動的速度（m/s）＝ timeScale=1 時不滑步的移動速度"""
    sc = bpy.context.scene
    rig.animation_data.action = bpy.data.actions[act_name]
    pos = {S: [] for S in ('Left', 'Right')}
    for f in range(0, frames + 1):
        sc.frame_set(f)
        for S in pos:
            pos[S].append((rig.matrix_world @ rig.pose.bones[f'{S}ToeBase'].head).copy())
    rig.animation_data.action = None
    speeds = []
    for S, ps in pos.items():
        zmin = min(p.z for p in ps)
        for i in range(1, len(ps)):
            if ps[i].z < zmin + 0.015 and ps[i - 1].z < zmin + 0.015:
                speeds.append((ps[i].y - ps[i - 1].y) * FPS)  # 往 +Y（後方）為正
    v = float(np.median(speeds)) if speeds else 0.0
    print(f'[violinist] {act_name} gait ref {v:.2f} m/s')
    return v


# ───────────────────────── 2. 道具 ─────────────────────────
def add_prop_bones(rig):
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix()
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    eb = rig.data.edit_bones
    out = {}
    for name, hand, side in (('prop_violin', 'LeftHand', 1), ('prop_bow', 'RightHand', -1)):
        h = eb[hand]
        d = (h.tail - h.head).normalized()
        if abs(d.x) < 0.5:
            d = Vector((side, 0, 0))
        b = eb.new(name)
        b.head = h.head + d * 0.055
        # rest 方向：沿手的方向（手臂下垂時琴與弓自然下垂），琴面朝前；弓略往前傾
        y = (d + FWD * (0.0 if name == 'prop_violin' else 0.45)).normalized()
        b.tail = b.head + y * 0.1
        b.align_roll(FWD if name == 'prop_violin' else Vector((0, 0, 1)))
        b.parent = h
        b.use_deform = False
        out[name] = name
    bpy.ops.object.mode_set(mode='OBJECT')
    return out


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def load_violin():
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(ASSET_DIR, SRC_VIOLIN))
    obs = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    ob = obs[0]
    for o in [o for o in bpy.data.objects if o not in before and o is not ob]:
        bpy.data.objects.remove(o, do_unlink=True)
    ob.name = ob.data.name = 'Violin'
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    ob.parent = None
    # 減面：64 萬頂點 → 約 9k 三角形
    dec = ob.modifiers.new('Dec', 'DECIMATE')
    dec.ratio = min(1.0, VIOLIN_TRIS / max(1, tri_count(ob)))
    dec.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier='Dec')
    me = ob.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    s = VIOLIN_LEN / (co[:, 2].max() - co[:, 2].min())
    co *= s
    z0 = co[:, 2].min()
    zg = z0 + VIOLIN_GRIP * VIOLIN_LEN
    band = co[np.abs(co[:, 2] - zg) < 0.012]
    band = band[band[:, 0] < np.percentile(band[:, 0], 70)]  # 去掉右側緞帶
    grip = np.array([np.median(band[:, 0]), np.median(band[:, 1]), zg])
    co -= grip
    # 道具骨區域座標：+Y 由握把指向琴尾（琴身）、+Z 為琴面（琴弦那一面，來源 -Y）
    out = np.stack([-co[:, 0], -co[:, 2], -co[:, 1]], axis=1)
    me.vertices.foreach_set('co', out.reshape(-1))
    me.update()
    for p in me.polygons:
        p.use_smooth = True
    mat = me.materials[0]
    mat.name = 'M_Violin'
    for n in mat.node_tree.nodes:
        if n.type == 'TEX_IMAGE' and n.image:
            img = n.image
            if n.image.colorspace_settings.is_data and 'Normal' in [l.to_socket.name for l in n.outputs[0].links]:
                # 法線貼圖：遊戲距離看不出來，移除以節省容量
                mat.node_tree.nodes.remove(n)
                continue
            img.name = 'violin_' + ('orm' if img.colorspace_settings.is_data else 'color')
            target = 1024 if not img.colorspace_settings.is_data else 512
            if img.size[0] > target:
                img.scale(target, target)
    for n in list(mat.node_tree.nodes):
        if n.type == 'NORMAL_MAP':
            mat.node_tree.nodes.remove(n)
    print(f'[violinist] violin tris {tri_count(ob)}')
    return ob


def pbr(name, color, rough=0.5, metal=0.0, emit=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1)
        b.inputs['Emission Strength'].default_value = 1.0
    return m


def build_bow():
    """程序化琴弓（設定表：深色木桿、金色弓根 / 弓尖、紫色緞帶與白花）。原點＝右手握持的弓根，+Y 指向弓尖，弓毛在 -Z 側"""
    bm = bmesh.new()
    mats = [pbr('M_BowWood', (0.22, 0.11, 0.05), 0.45), pbr('M_BowGold', (0.85, 0.62, 0.25), 0.3, 1.0),
            pbr('M_BowHair', (0.95, 0.93, 0.88), 0.8), pbr('M_BowRibbon', (0.55, 0.32, 0.85), 0.6, emit=(0.12, 0.05, 0.2))]

    def tube(p0, p1, r0, r1, mat, seg=6):
        d = (p1 - p0)
        n = d.normalized()
        a = n.orthogonal().normalized()
        b = n.cross(a)
        rings = []
        for p, r in ((p0, r0), (p1, r1)):
            rings.append([bm.verts.new(p + (a * Cs(i * TAU / seg) + b * Sn(i * TAU / seg)) * r) for i in range(seg)])
        for i in range(seg):
            f = bm.faces.new((rings[0][i], rings[0][(i + 1) % seg], rings[1][(i + 1) % seg], rings[1][i]))
            f.material_index = mat
        for ring, rev in ((rings[0], True), (rings[1], False)):
            f = bm.faces.new(list(reversed(ring)) if rev else ring)
            f.material_index = mat

    def box(c, size, mat):
        r = bmesh.ops.create_cube(bm, size=1.0)
        for v in r['verts']:
            v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2])) + c
        for f in {f for v in r['verts'] for f in v.link_faces}:
            f.material_index = mat

    # 木桿：微微弓起（中段往弓毛側彎）
    N = 8
    pts = [Vector((0, -0.04 + (BOW_LEN + 0.04) * i / N, -0.006 * Sn(math.pi * i / N))) for i in range(N + 1)]
    for i in range(N):
        tube(pts[i], pts[i + 1], 0.0055 - 0.002 * i / N, 0.0055 - 0.002 * (i + 1) / N, 0)
    box(Vector((0, -0.005, -0.012)), (0.012, 0.045, 0.02), 1)  # 弓根（金）
    box(Vector((0, BOW_LEN - 0.005, -0.01)), (0.008, 0.02, 0.024), 1)  # 弓尖
    tube(Vector((0, 0.02, -0.02)), Vector((0, BOW_LEN - 0.015, -0.02)), 0.0035, 0.0035, 2, seg=4)  # 弓毛
    # 弓根的紫色緞帶（兩條垂下）與白花
    for s in (-1, 1):
        tube(Vector((0, -0.02, -0.01)), Vector((0.02 * s, -0.06, -0.08)), 0.004, 0.006, 3, seg=4)
    box(Vector((0, -0.03, 0.0)), (0.02, 0.02, 0.02), 2)
    me = bpy.data.meshes.new('Bow')
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    ob = bpy.data.objects.new('Bow', me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def attach(ob, rig, bone):
    """把道具（已在骨頭區域座標）掛到骨頭上"""
    # 骨頭父子關係以骨頭「尾端」為原點：往回移一個骨長，讓道具原點落在骨頭頭（握持點）
    b = rig.data.bones[bone]
    ob.parent = rig
    ob.parent_type = 'BONE'
    ob.parent_bone = bone
    ob.matrix_parent_inverse = Matrix()
    ob.matrix_basis = Matrix.Translation((0, -b.length, 0))


# ───────────────────────── 3. 動作 ─────────────────────────
def build_actions(rig, me, fidx):
    sc = bpy.context.scene
    bones = rig.data.bones
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    keyed = [b.name for b in bones if b.name not in ('headfront', 'HeadTop_End')]
    head0 = {b.name: b.head_local.copy() for b in bones}
    L = {S: dict(up=(head0[f'{S}ForeArm'] - head0[f'{S}Arm']).length, lo=(head0[f'{S}Hand'] - head0[f'{S}ForeArm']).length)
         for S in ('Left', 'Right')}
    LL = {S: dict(up=(head0[f'{S}Leg'] - head0[f'{S}UpLeg']).length, lo=(head0[f'{S}Foot'] - head0[f'{S}Leg']).length)
          for S in ('Left', 'Right')}
    SH = {S: head0[f'{S}Arm'] for S in ('Left', 'Right')}
    # Mixamo 的 rest（T-pose）腳底離地約 0.1 m（動作中骨盆較低）：IK 的腳踝目標要扣掉這段高度才會貼地
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix()
    bpy.context.view_layer.update()
    lift = float(eval_coords(me, fidx)[:, 2].min())
    ANK = {S: head0[f'{S}Foot'] - Vector((0, 0, lift)) for S in ('Left', 'Right')}
    print(f'[violinist] rest feet lift {lift:.3f}')
    hip_z = head0['Hips'].z
    chin = Vector((0.0, -0.11, head0['Head'].z - 0.04))
    print(f'[violinist] arm {L["Left"]}, leg {LL["Left"]}, hips {hip_z:.3f}')

    def upd():
        bpy.context.view_layer.update()

    def R(bname, *rots):
        Bm = bones[bname].matrix_local.to_3x3().inverted()
        q = Quaternion()
        for ax, deg in rots:
            q = Quaternion(Bm @ ax, math.radians(deg)) @ q
        return q

    def child_of(name):
        return {'LeftArm': 'LeftForeArm', 'LeftForeArm': 'LeftHand', 'RightArm': 'RightForeArm', 'RightForeArm': 'RightHand',
                'LeftUpLeg': 'LeftLeg', 'LeftLeg': 'LeftFoot', 'RightUpLeg': 'RightLeg', 'RightLeg': 'RightFoot'}.get(name)

    def aim(P, name, target):
        """旋轉骨頭，讓「骨頭頭 → 子骨頭頭」指向目標點（不依賴骨頭軸向；最小旋轉保留扭轉）"""
        upd()
        pb = P[name]
        c = child_of(name)
        head = pb.head.copy()
        cur = (P[c].head - head) if c else (pb.tail - head)
        rot = cur.normalized().rotation_difference((Vector(target) - head).normalized()).to_matrix()
        M = pb.matrix.copy()
        pb.matrix = Matrix.Translation(head) @ (rot @ M.to_3x3()).to_4x4()
        upd()

    def ik(P, up, lo, a, b, target, pole):
        upd()
        S = P[up].head.copy()
        T = Vector(target)
        d = T - S
        dist = min(d.length, (a + b) * 0.999)
        dn = d.normalized()
        ca = max(-1.0, min(1.0, (a * a + dist * dist - b * b) / (2 * a * dist)))
        pl = Vector(pole)
        pl = (pl - dn * pl.dot(dn)).normalized()
        elbow = S + dn * a * ca + pl * a * math.sqrt(1 - ca * ca)
        aim(P, up, elbow)
        aim(P, lo, S + dn * dist)

    def arm(P, S, hand, pole, wrist=None):
        """手腕（Hand 骨頭頭）到 hand；wrist：手掌方向（世界）"""
        ik(P, f'{S}Arm', f'{S}ForeArm', L[S]['up'], L[S]['lo'], hand, pole)
        if wrist is not None:
            upd()
            aim(P, f'{S}Hand', P[f'{S}Hand'].head + Vector(wrist))

    def leg(P, S, ankle, pole=FWD, flat=True):
        ik(P, f'{S}UpLeg', f'{S}Leg', LL[S]['up'], LL[S]['lo'], ankle, pole)
        if flat:  # 腳掌維持 rest 的世界方向（高跟鞋貼地）
            upd()
            pb = P[f'{S}Foot']
            pb.matrix = Matrix.Translation(pb.head) @ bones[f'{S}Foot'].matrix_local.to_3x3().to_4x4()
            upd()

    def hips(P, off=(0, 0, 0), *rots):
        P['Hips'].rotation_quaternion = R('Hips', *rots)
        upd()
        pb = P['Hips']
        M = pb.matrix.copy()
        M.translation = head0['Hips'] + Vector(off)
        pb.matrix = M
        upd()

    def palm(P, S):
        upd()
        h = P[f'{S}Hand']
        return h.head + (h.tail - h.head).normalized() * 0.055

    def place(P, name, origin, ydir, zdir):
        y = Vector(ydir).normalized()
        z = Vector(zdir)
        z = (z - y * z.dot(y)).normalized()
        x = y.cross(z)
        M = Matrix((x, y, z)).transposed().to_4x4()
        M.translation = Vector(origin)
        P[name].matrix = M
        upd()

    def hang(P, side_violin=True, bow_fwd=0.45):
        """道具跟著手自然下垂（rest 關係）"""
        upd()
        for name, S in (('prop_violin', 'Left'), ('prop_bow', 'Right')):
            P[name].matrix_basis = Matrix()
        upd()

    def violin_chest(P, k=1.0):
        """衝鋒：小提琴緊抱在胸前左側（琴頸朝上、琴面朝外）"""
        o = palm(P, 'Left')
        place(P, 'prop_violin', o, vlerp((0.25, -0.4, -1), (-0.35, -0.15, -1), k), vlerp(FWD, (0.6, -1, 0.2), k))

    def bow_dir(P, d, up=(0, 0, 1)):
        place(P, 'prop_bow', palm(P, 'Right'), d, up)

    def violin_play(P, stroke):
        """拉琴：琴尾靠在左鎖骨、下巴夾琴；琴弓永遠通過琴橋附近的接觸點"""
        d = Vector((0.55, -0.82, 0.12)).normalized()
        tail = Vector((0.055, -0.085, chin.z - 0.025))
        grip = tail + d * (VIOLIN_GRIP * VIOLIN_LEN)
        arm(P, 'Left', grip - d * 0.05 + Vector((0, 0.0, -0.035)), (0.3, 0.3, -1), wrist=(0.1, -0.5, 0.6))
        # 琴弓接近水平、垂直琴弦（朝左後方），琴面法線由兩者決定（自然往右傾）
        hb = Vector((0.82, 0.57, -0.06))
        across = (hb - d * hb.dot(d)).normalized()
        face = d.cross(across)
        if face.z < 0:
            face = -face
        place(P, 'prop_violin', grip, -d, face)
        upd()
        contact = grip - d * 0.18 + face * 0.04  # 琴橋（距琴尾約 1/3）
        reach = lerp(0.06, 0.25, stroke)  # 手臂偏短：只用弓的下半段運弓
        hand = contact - across * reach + Vector((0, 0, -0.02))
        arm(P, 'Right', hand, (-1, 0.4, -0.6), wrist=across + Vector((0, 0, 0.3)))
        o = palm(P, 'Right')
        place(P, 'prop_bow', o, contact - o, face + Vector((0, 0, 0.5)))

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
            t = f / length
            fn(t, P)
            if ground:
                low = eval_coords(me, fidx)[:, 2].min()
                pb = P['Hips']
                M = pb.matrix.copy()
                M.translation.z -= low + SINK
                pb.matrix = M
                upd()
            for n in keyed:
                P[n].keyframe_insert('rotation_quaternion', frame=f)
            for n in ('Hips', 'prop_violin', 'prop_bow'):
                P[n].keyframe_insert('location', frame=f)
        if loop:
            # 循環動作：加上 Cycles 修飾器，Blender 會以循環方式計算自動切線，
            # 循環接縫處的速度連續（否則首尾切線被夾成水平，每圈都會頓一下）
            for fc in channel_fcurves(act):
                if not any(md.type == 'CYCLES' for md in fc.modifiers):
                    fc.modifiers.new('CYCLES')
                fc.update()
        return act

    # ── 站姿：手臂從 T-pose 放下 ──
    def rest_arms(P, b=0.0, k=1.0):
        for S, s in (('Left', 1), ('Right', -1)):
            sh = SH[S]
            hand = vlerp(sh + Vector((s * (L[S]['up'] + L[S]['lo']), 0, 0)), sh + Vector((s * 0.085, -0.07, -0.28 + 0.004 * b)), k)
            arm(P, S, hand, (s * 0.2, 0.6, 0), wrist=(s * 0.15, -0.25, -1))

    def idle(t, P):
        b = Sn(t * TAU)
        hips(P, (0, 0, 0), (Y, 1.5 * b), (Z, 3 * b))
        P['Spine1'].rotation_quaternion = R('Spine1', (X, 1.2 * b))
        P['Neck'].rotation_quaternion = R('Neck', (Z, 2 * b))
        P['Head'].rotation_quaternion = R('Head', (Y, 3 * Sn(t * TAU + 1)), (Z, 4 * b), (X, 4))
        rest_arms(P, b)
        hang(P)

    def play(t, P):
        # 拉小提琴：琴夾在下巴下、左手扶琴頸、右手長弓來回、身體輕輕搖擺
        stroke = 0.5 - 0.5 * Cs(t * TAU * 2)
        sway = Sn(t * TAU)
        hips(P, (0, 0, 0), (Y, 2.5 * sway), (Z, 3 * sway))
        P['Spine'].rotation_quaternion = R('Spine', (Z, 6), (Y, -2 * sway))
        P['Spine1'].rotation_quaternion = R('Spine1', (Y, -3 * sway), (X, -2))
        P['Spine2'].rotation_quaternion = R('Spine2', (Z, 5))
        P['Neck'].rotation_quaternion = R('Neck', (Y, 10), (X, 6))
        P['Head'].rotation_quaternion = R('Head', (Y, 14 + 2 * sway), (Z, 12), (X, 10))
        violin_play(P, stroke)

    def cast(t, P):
        # 刺客之眼：琴弓手舉到右眼前，低頭凝視
        k = smooth(t * 3)
        hips(P, (0, 0, 0))
        P['Spine1'].rotation_quaternion = R('Spine1', (Z, -10 * k))
        P['Head'].rotation_quaternion = R('Head', (X, 10 * k), (Z, -8 * k))
        rest_arms(P)
        sh = SH['Right']
        rest = sh + Vector((-0.085, -0.07, -0.28))
        arm(P, 'Right', vlerp(rest, (-0.07, -0.2, head0['Head'].z + 0.03), k), (-1, 0.3, -0.6), wrist=vlerp((0, -0.25, -1), (0.5, -0.4, 0.7), k))
        hang(P)
        if k > 0:
            bow_dir(P, vlerp((-0.1, -0.35, -1), (-0.6, -0.3, 1), k), (0, -1, 0))

    def windup(t, P):
        # 衝鋒前搖（0.5 s）：屈膝蹲低、上身往後扭、小提琴抱在胸前、琴弓手像拔劍般往後拉
        k = smooth(t * 1.6)
        lean = 6 * k
        hips(P, (0, 0.04 * k, -0.13 * k), (Z, 22 * k), (X, lean))
        P['Spine'].rotation_quaternion = R('Spine', (Z, 10 * k), (X, 8 * k))
        P['Spine1'].rotation_quaternion = R('Spine1', (Z, 8 * k), (X, 4 * k))
        P['Head'].rotation_quaternion = R('Head', (Z, -36 * k), (X, -8 * k))
        leg(P, 'Left', ANK['Left'] + Vector((0.03, -0.16 * k, -SINK)), (0.2, -1, 0))
        leg(P, 'Right', ANK['Right'] + Vector((-0.03, 0.18 * k, -SINK)), (-0.2, -1, 0))
        upd()
        ch = P['Spine2'].head
        arm(P, 'Left', vlerp(SH['Left'] + Vector((0.085, -0.07, -0.28)), ch + Vector((0.02, -0.17, -0.06)), k), (0.6, 0.3, -1), wrist=(-0.6, -0.4, 0.4))
        arm(P, 'Right', vlerp(SH['Right'] + Vector((-0.085, -0.07, -0.28)), ch + Vector((-0.24, 0.2, -0.2)), k), (-0.3, 1, -0.5), wrist=(0, -1, 0.1))
        violin_chest(P, k)
        bow_dir(P, vlerp((-0.1, -0.35, -1), (0.05, -1, 0.05), k), (0, 0, 1))

    def dash(t, P):
        # 衝鋒突刺（循環）：低身滑行、上身大幅前傾、大步輕盈、琴弓如細劍刺向前方
        a = Sn(t * TAU)
        hips(P, (0, 0, -0.12 + 0.02 * abs(Cs(t * TAU))), (X, 24), (Z, 6 * a))
        P['Spine'].rotation_quaternion = R('Spine', (X, 12))
        P['Spine1'].rotation_quaternion = R('Spine1', (X, 6), (Z, -4 * a))
        P['Head'].rotation_quaternion = R('Head', (X, -34))
        for S, ph in (('Left', 0.0), ('Right', math.pi)):
            s = Sn(t * TAU + ph)
            lift = max(0.0, Cs(t * TAU + ph)) * 0.14
            leg(P, S, ANK[S] + Vector((0, -0.34 * s, lift - SINK)), (0, -1, 0.2), flat=False)
        upd()
        ch = P['Spine2'].head
        arm(P, 'Left', ch + Vector((0.07, -0.16, -0.1)), (0.8, 0.4, -1), wrist=(-0.6, -0.4, 0.4))
        arm(P, 'Right', ch + Vector((-0.06, -0.42, 0.0)), (-1, 0, -0.4), wrist=(0.1, -1, 0.05))
        violin_chest(P)
        bow_dir(P, (0.06, -1, 0.02), (0, 0, 1))

    def recover(t, P):
        # 衝鋒收招（命中與落空共用）：前膝彎曲滑停、弓尖停在前方片刻，再優雅地站直
        k = smooth((t - 0.4) / 0.6)
        hips(P, (0, 0.06 * (1 - k), -0.15 * (1 - k)), (X, 14 * (1 - k)))
        P['Spine'].rotation_quaternion = R('Spine', (X, 10 * (1 - k)))
        P['Head'].rotation_quaternion = R('Head', (X, -16 * (1 - k)))
        leg(P, 'Left', ANK['Left'] + Vector((0.02, -0.32 * (1 - k), -SINK)), (0.2, -1, 0))
        leg(P, 'Right', ANK['Right'] + Vector((-0.02, 0.3 * (1 - k), -SINK)), (-0.2, -1, 0))
        upd()
        ch = P['Spine2'].head
        rl = SH['Left'] + Vector((0.085, -0.07, -0.28))
        rr = SH['Right'] + Vector((-0.085, -0.07, -0.28))
        arm(P, 'Left', vlerp(ch + Vector((0.07, -0.16, -0.1)), rl, k), (0.8, 0.4, -1), wrist=vlerp((-0.6, -0.4, 0.4), (0.15, -0.25, -1), k))
        arm(P, 'Right', vlerp(ch + Vector((-0.04, -0.44, 0.02)), rr, k), (-1, 0.2, -0.4), wrist=vlerp((0.1, -1, 0.05), (-0.15, -0.25, -1), k))
        if k < 1:
            violin_chest(P, 1 - k)
            bow_dir(P, vlerp((0.06, -1, 0.02), (-0.1, -0.35, -1), k), (0, 0, 1))
        else:
            hang(P)

    def capture(t, P):
        # 捕獲：彎腰把哥布林裝進麻袋（與預設精靈相同節奏）
        k = Sn(t * TAU * 2)
        hips(P, (0, 0.03, -0.1), (X, 8))
        P['Spine'].rotation_quaternion = R('Spine', (X, 16))
        P['Spine1'].rotation_quaternion = R('Spine1', (X, 12))
        P['Head'].rotation_quaternion = R('Head', (X, 14))
        for S in ('Left', 'Right'):
            leg(P, S, ANK[S] + Vector((0, -0.04, -SINK)), (0, -1, 0))
        upd()
        ch = P['Spine2'].head
        arm(P, 'Left', ch + Vector((0.13, -0.32, -0.38 + 0.06 * k)), (1, 0.3, -0.3), wrist=(0, -0.5, -1))
        arm(P, 'Right', ch + Vector((-0.13, -0.32, -0.38 - 0.06 * k)), (-1, 0.3, -0.3), wrist=(0, -0.5, -1))
        hang(P)

    def victory(t, P):
        # 勝利：高舉琴弓、小提琴抱在身側，輕輕轉身
        b = Sn(t * TAU)
        hips(P, (0, 0, 0), (Z, 8 * b))
        P['Spine1'].rotation_quaternion = R('Spine1', (X, -6), (Y, 3 * b))
        P['Head'].rotation_quaternion = R('Head', (X, -12), (Z, 6 * b))
        rest_arms(P)
        arm(P, 'Right', SH['Right'] + Vector((-0.12, -0.08, 0.26 + 0.02 * b)), (-1, 0.3, 0), wrist=(-0.2, -0.2, 1))
        hang(P)
        bow_dir(P, (-0.35 + 0.15 * b, -0.25, 1), (0, -1, 0))

    def stunned(t, P):
        hips(P, (0, 0, 0), (Z, 4 * Sn(t * TAU + 1)))
        P['Spine1'].rotation_quaternion = R('Spine1', (Z, 6 * Sn(t * TAU + 0.5)))
        P['Head'].rotation_quaternion = R('Head', (Z, 16 * Sn(t * TAU)), (X, 8))
        for S, s in (('Left', 1), ('Right', -1)):
            arm(P, S, SH[S] + Vector((s * 0.18, -0.12, -0.2)), (s * 0.5, 0.5, -0.2), wrist=(s * 0.4, -0.3, -1))
        hang(P)

    make('Idle', 60, idle, 3)
    make('Play', 48, play, 2)
    make('Cast', 16, cast, 2, loop=False)
    make('ChargeWindup', 12, windup, 2, loop=False, ground=False)
    make('ChargeDash', 12, dash, 1, ground=False)
    make('ChargeRecover', 12, recover, 2, loop=False, ground=False)
    make('Capture', 16, capture, 2, ground=False)
    make('Victory', 48, victory, 2)
    make('Stunned', 30, stunned, 2)
    rig.animation_data.action = bpy.data.actions['Idle']
    reset_pose()


# ───────────────────────── 4. 材質 / LOD / 匯出 ─────────────────────────
def prep_material(ob):
    mat = ob.data.materials[0]
    mat.name = 'M_Violet'
    for n in mat.node_tree.nodes:
        if n.type == 'TEX_IMAGE' and n.image:
            img = n.image
            is_mr = 'metallic' in img.name or 'rough' in img.name
            img.name = 'violet_orm' if is_mr else 'violet_color'
            if not is_mr:
                save_hires(img)
            target = TEX_SIZE // 2 if is_mr else TEX_SIZE
            if img.size[0] > target:
                img.scale(target, target)


def save_hires(img):
    """原尺寸色彩貼圖另存 WebP（public/models/violinist/violet_color_4k.webp），桌機放大時看得到細節"""
    cwebp = shutil.which('cwebp')
    if not cwebp:
        print('[violinist] 找不到 cwebp，略過 4K 貼圖')
        return
    os.makedirs(OUT_GLB, exist_ok=True)
    tmp = os.path.join(OUT_BLEND, 'violet_color_hires.png')
    os.makedirs(OUT_BLEND, exist_ok=True)
    hi = img.copy()
    if hi.size[0] > HIRES_SIZE:
        hi.scale(HIRES_SIZE, HIRES_SIZE)
    hi.filepath_raw = tmp
    hi.file_format = 'PNG'
    hi.save()
    bpy.data.images.remove(hi)
    out = os.path.join(OUT_GLB, 'violet_color_4k.webp')
    subprocess.run([cwebp, '-quiet', '-q', str(HIRES_QUALITY), '-m', '6', '-sharp_yuv', tmp, '-o', out], check=True)
    os.remove(tmp)
    print('[violinist] hires', out, os.path.getsize(out) // 1024, 'KB')


def make_lod1(lod0, rig):
    bpy.ops.object.select_all(action='DESELECT')
    lod0.select_set(True)
    bpy.context.view_layer.objects.active = lod0
    bpy.ops.object.duplicate()
    lod1 = bpy.context.active_object
    lod1.name = lod1.data.name = 'VioletMesh_LOD1'
    arm_mod = [m for m in lod1.modifiers if m.type == 'ARMATURE']
    for m in arm_mod:
        lod1.modifiers.remove(m)
    dec = lod1.modifiers.new('Dec', 'DECIMATE')
    dec.ratio = LOD1_RATIO
    bpy.ops.object.modifier_apply(modifier='Dec')
    # 減面會內插權重：每個頂點只保留最大的 4 個並正規化
    for v in lod1.data.vertices:
        gs = sorted(((g.group, g.weight) for g in v.groups), key=lambda x: -x[1])
        keep = gs[:4]
        s = sum(w for _, w in keep) or 1.0
        for g, _ in gs[4:]:
            lod1.vertex_groups[g].remove([v.index])
        for g, w in keep:
            lod1.vertex_groups[g].add([v.index], w / s, 'REPLACE')
    mod = lod1.modifiers.new('Armature', 'ARMATURE')
    mod.object = rig
    return lod1


def export(rig, objs):
    os.makedirs(OUT_GLB, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for o in [rig] + objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = rig
    path = os.path.join(OUT_GLB, 'violinist.glb')
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True,
        export_animations=True, export_animation_mode='ACTIONS', export_skins=True,
        export_apply=False, export_yup=True, export_texcoords=True, export_normals=True,
        export_image_format='WEBP', export_image_quality=88, export_def_bones=False, export_force_sampling=True,
        export_optimize_animation_size=True, export_meshopt_compression_enable=True,
        export_attributes=True,  # _FACEMASK（臉部遮罩，遊戲 shader 使用）
    )
    print('[violinist] exported', path, os.path.getsize(path) // 1024, 'KB')


def preview(rig):
    """每個動作輸出幾張 workbench 預覽圖，方便檢查姿勢"""
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'TEXTURE'
    sc.render.resolution_x = sc.render.resolution_y = 360
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = 2.0
    for act in bpy.data.actions:
        rig.animation_data.action = act
        f0, f1 = act.frame_range
        for i, f in enumerate((f0, (f0 + f1) / 2, f1)):
            sc.frame_set(int(f))
            for view, loc in (('q', (2.6, -3.2, 1.25)), ('s', (4, 0, 0.9))):
                cam.location = Vector(loc)
                cam.rotation_euler = (Vector((0, 0, 0.85)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
                sc.render.filepath = os.path.join(PREVIEW_DIR, f'{act.name}_{i}_{view}.png')
                bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)
    rig.animation_data.action = bpy.data.actions['Idle']


def main(do_export=True):
    reset()
    rig, me = load_char()
    weld_and_smooth(me)
    fidx = foot_verts(me)
    ground(rig, me, fidx)
    remove_inner_face_layer(me)  # FACE_CENTER 是接地後的座標
    fidx = foot_verts(me)  # 刪面會一併移除孤立頂點，頂點索引改變
    face_normals(me)
    walk_ref = measure_gait(rig, 'Walk', 24)
    run_ref = measure_gait(rig, 'Run', 15)
    add_prop_bones(rig)
    violin = load_violin()
    attach(violin, rig, 'prop_violin')
    bow = build_bow()
    attach(bow, rig, 'prop_bow')
    prep_material(me)
    build_actions(rig, me, fidx)
    lod1 = make_lod1(me, rig)
    os.makedirs(OUT_BLEND, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_BLEND, 'violinist.blend'))
    if os.environ.get('VIOLINIST_PREVIEW') == '1':
        lod1.hide_render = True
        preview(rig)
        lod1.hide_render = False
    if do_export:
        export(rig, [me, lod1, violin, bow])
    print(f'[violinist] VIOLINIST_GAIT_REF = {{ Walk: {walk_ref:.2f}, Run: {run_ref:.2f} }}')


if __name__ == '__main__' or __name__ == '<run_path>' or __name__ == 'builtins':
    main(do_export=os.environ.get('VIOLINIST_NO_EXPORT') != '1')
