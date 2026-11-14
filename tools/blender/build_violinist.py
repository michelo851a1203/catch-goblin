"""
Catch Goblin — 紫晶精靈（小提琴刺客）：Meshy.ai Mixamo 綁骨模型 → 正規化 / 程序化動作 / 道具 / LOD / 匯出

來源（Meshy.ai 產出，放在 repo 外層的 assets/assets_紫髮法師/）：
    紫晶精靈_ultra2K/Meshy_AI_Elven_Maiden_Ultra_Rigged_*_animated_mixamo_All_animation.glb   角色（Mixamo 骨架 + 權重 + Walking / Running，約 3 萬面）
    紫晶精靈_ultra2K/Meshy_AI_Elven_Maiden_Ultra_*_image-to-3d-texture.blend                 高模（384 萬面 + 4K 法線貼圖），烘焙法線貼圖用
    Elven_Violin.glb                                                                          小提琴（64 萬頂點，減面後使用）

用法：
    blender -b -P tools/blender/build_violinist.py
    （可用環境變數 VIOLINIST_ASSET_DIR 指定素材資料夾；VIOLINIST_PREVIEW=1 時另外輸出各動作的預覽圖；
      高模法線貼圖的烘焙結果快取在 tools/blender/out/violet_normal_bake.png，VIOLINIST_REBAKE=1 強制重新烘焙）

輸出：
    public/models/violinist/violinist.glb   LOD0 + LOD1 共用骨架（含布料 / 頭髮彈簧骨 47 根）、小提琴與琴弓（掛在 prop_violin / prop_bow 骨）、11 個動作
    tools/blender/out/violinist.blend

流程：
  1. 匯入 Mixamo GLB、套用 0.01 縮放（cm → m）、骨頭去掉 "mixamorig:" 前綴、腳底對齊 y=0（骨架與網格位移相同的量）
  2. 腿部關節校正與布料（rig_cloth）：Meshy 的自動綁骨把膝關節放在腿後方 16 cm，裙擺 / 垂袖又全部綁在腿骨上。
     以測地線把網格分成 腿 / 身體 / 裙擺 / 垂袖 / 頭髮，切開互相融合的橋接面，膝關節移回腿中心，
     布料的腿骨權重改掛到彈簧骨鏈（裙擺 8×4、垂袖 2×3、頭髮 3×3），遊戲端以 SecondaryMotion 驅動
  3. 新增道具骨 prop_violin（左手）/ prop_bow（右手），小提琴減面後與程序化琴弓以骨頭父子關係掛上
  4. 以「世界軸 + 相對 rest」與兩骨 IK 產生所有動作：待機、走路、奔跑（IK 步態，取代 Mixamo 的 Walking / Running）、
     拉琴、刺客之眼、衝鋒前搖 / 突刺 / 收招、捕獲、勝利、暈眩。
     道具骨每格依手的位置重新擺放（拉琴時琴弓永遠通過琴橋附近的接觸點）
  5. 由高模烘焙切線空間法線貼圖到低模（布料皺褶、飾品、五官細節，不增加面數）
  6. LOD1 減面、貼圖縮小為 WebP、匯出 GLB（EXT_meshopt_compression，含 MikkTSpace 切線）
"""
import bpy, bmesh, math, os, shutil, subprocess
import numpy as np
from mathutils import Vector, Quaternion, Matrix

try:
    REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
except NameError:
    REPO = '/Users/michaelho/main/project/2026-10-20-side-hustle/goblin-game'
ASSET_DIR = os.environ.get('VIOLINIST_ASSET_DIR', os.path.join(os.path.dirname(REPO), 'assets', 'assets_紫髮法師'))
ULTRA_DIR = os.path.join(ASSET_DIR, '紫晶精靈_ultra2K')
SRC_CHAR = os.path.join(ULTRA_DIR, 'Meshy_AI_Elven_Maiden_Ultra_Rigged_20261109_animated_mixamo_All_animation.glb')
SRC_HIGH = os.path.join(ULTRA_DIR, 'Meshy_AI_Elven_Maiden_Ultra_20261109_image-to-3d-texture.blend')
SRC_VIOLIN = 'Elven_Violin.glb'
OUT_GLB = os.path.join(REPO, 'public', 'models', 'violinist')
OUT_BLEND = os.path.join(REPO, 'tools', 'blender', 'out')
PREVIEW_DIR = os.environ.get('VIOLINIST_PREVIEW_DIR', os.path.join(OUT_BLEND, 'violinist_preview'))

TEX_SIZE = 2048
BAKE_SIZE = 4096
# 高模與低模表面最大誤差約 0.9 mm：光線由低模往外 3 mm 起射、最遠 6 mm，避免打到相鄰的布料層
BAKE_CAGE = 0.003
BAKE_RAY = 0.006
BAKE_CACHE = 'violet_normal_bake.png'
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
# 程序化步態：timeScale=1 時腳底相對地面的速度（m/s）；遊戲端 VIOLINIST_ANIM.gaitRef 要一致
WALK_FRAMES, WALK_REF = 16, 1.6  # 0.67 s 一個循環，步幅約 0.53 m
RUN_FRAMES, RUN_REF = 12, 6.0  # 0.5 s 一個循環；精靈 7.4 m/s 時播放速率 1.23

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
    bpy.ops.import_scene.gltf(filepath=SRC_CHAR)
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


def weld_and_smooth(me, ref=None):
    """Meshy 的網格是三角形湯：6 萬頂點幾乎全是重複點、每個三角形互不相連。
    不焊接的話法線是一面一面的（臉像多面體）、描邊會從三角形的縫隙漏出來，LOD1 減面也會破碎。
    焊接後清掉匯入的自訂法線，依角度重建平滑法線"""
    n0 = len(me.data.vertices)
    bm = bmesh.new()
    bm.from_mesh(me.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=WELD_DIST)
    if ref:
        bm.faces.index_update()
        orient_to_high(bm, ref)
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


def skin_vertices(me):
    """取每個頂點的平均 UV 對色彩貼圖取樣：膚色頂點（頭髮 / 瀏海是紫色，不屬於臉）"""
    m = me.data
    n = len(m.vertices)
    img = next(l.from_node.image for l in m.materials[0].node_tree.links if l.to_socket.name == 'Base Color' and l.from_node.type == 'TEX_IMAGE')
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
    return (c[:, 0] > c[:, 1]) & (c[:, 1] > c[:, 2] - 0.02) & (c[:, 0] - c[:, 2] > 0.05) & (c[:, 0] > 0.5)


def remove_inner_face_layer(me):
    """Meshy 的臉是雙層殼：外層皮膚後方 4–7 mm 還有一層朝內的面。內層永遠被外層蓋住看不到，
    但描邊（OutlineEffect 沿法線外擴的背面殼）會從髮際線的縫隙透出來，在額頭上留下咖啡色碎片。
    描邊殼是沿各面自己的法線外擴，所以判斷條件就是「沿自己的法線往外 10 mm 內，碰到一片幾乎平行的膚色面」：
      - 碰到的是膚色：瀏海下的額頭皮膚（前面是紫色頭髮）不會被誤刪
      - 碰到的面要與自己平行（法線夾角 < 60°）：鼻翼側面朝向臉頰，不會被當成內層刪掉
      - 不限範圍、不論面方向：orient_to_high 翻面後內層也可能朝外，臉頰側面也有內層"""
    from mathutils.bvhtree import BVHTree
    bm = bmesh.new()
    bm.from_mesh(me.data)
    bm.normal_update()
    dl = bm.verts.layers.deform.active
    hg = me.vertex_groups['Head'].index
    skin = skin_vertices(me)
    bm.faces.ensure_lookup_table()
    tree = BVHTree.FromBMesh(bm)
    kill = []
    for f in bm.faces:
        if any(v[dl].get(hg, 0.0) <= 0.5 for v in f.verts):
            continue
        c, n = f.calc_center_median(), f.normal
        loc, _, hit, _ = tree.ray_cast(c + n * 1e-4, n, 0.010)
        if loc is None:
            continue
        g = bm.faces[hit]
        if abs(g.normal.dot(n)) > 0.5 and sum(skin[v.index] for v in g.verts) >= 2:
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
    skin = skin_vertices(me)
    lv = np.empty(len(m.loops), dtype=np.int64)
    m.loops.foreach_get('vertex_index', lv)
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
    # 網格是骨架的子物件：兩者各移 dz 再套用，網格資料實際位移 2×dz、骨頭只有 dz —— 整副骨架比網格高 |dz|（約 4 cm），
    # 肩 / 肘 / 腕 / 髖 / 膝的轉軸都在肢體上方，道具（掛在手骨）也浮在手的上方。骨頭補上同樣的位移，讓關節回到肢體中心
    rig.data.transform(Matrix.Translation((0, 0, dz)))
    bpy.context.view_layer.update()
    print(f'[violinist] ground shift {dz:.3f} m')
    return dz


# ───────────────────────── 1b. 腿部關節校正 / 布料 ─────────────────────────
# Meshy（Mixamo 自動綁骨）的問題：
#   - 膝關節被放在「腿 + 裙子」側面剪影的中間：比真正的膝蓋往後 16 cm、高 6 cm，腿彎曲時繞著腿外面的點轉
#   - 裙擺、垂袖的下半部全部綁在腿骨上：走路時布料黏著腿、兩腿張開時被拉成一片
# 這裡把膝關節移回腿的中心、重分大腿 / 小腿權重，並把布料上的腿骨權重改掛到彈簧骨鏈
# （裙擺 8 條 × 4 節掛在 Hips、垂袖左右各 3 節掛在 Spine2），遊戲端以 SecondaryMotion 的 Verlet 彈簧驅動。
CLOTH_PREFIX = ('skirt_', 'drape_', 'hair_')
KNEE_Z = 0.50  # 腿部輪廓量測：小腿中心線在 0.44 以下垂直、0.44～0.53 往前移 4 cm（靴口正上方）；Mixamo 給的是 0.557
# 真正的腿中心線（rest pose，由水平切面量測）：z → (|x|, y)
LEG_Z = np.array([0.0, 0.12, 0.25, 0.35, 0.45, 0.55, 0.65, 0.85, 0.95])
LEG_Y = np.array([-0.055, -0.055, -0.07, -0.075, -0.09, -0.125, -0.13, -0.115, -0.09])
LEG_X = np.array([0.055, 0.055, 0.055, 0.057, 0.06, 0.06, 0.062, 0.075, 0.08])
SEG_LABELS = ('LEG', 'BODY', 'SKIRT', 'SLEEVE', 'HAIR')
# 裙擺鏈：方向（度，0 = 正前 -Y、90 = 左 +X）與節點高度；垂袖鏈的節點高度
SKIRT_C = (0.0, -0.03)
SKIRT_DIRS = [('F', 0), ('FL', 45), ('L', 90), ('BL', 135), ('B', 180), ('BR', -135), ('R', -90), ('FR', -45)]
SKIRT_Z = [0.98, 0.76, 0.54, 0.32, 0.08]
DRAPE_Z = [1.16, 0.93, 0.70, 0.46]
# 背後的長髮（肩膀以下）：3 條鏈的 x 位置與節點高度；髮根（HAIR_ROOT 以上）維持跟著頭 / 脖子
HAIR_X = [('L', 0.1), ('C', 0.0), ('R', -0.1)]
HAIR_Z = [1.38, 1.24, 1.10, 0.95]
HAIR_ROOT = (1.33, 1.41)


def leg_names(me):
    return [g.name for g in me.vertex_groups if g.name.endswith(('UpLeg', 'Leg', 'Foot', 'ToeBase'))]


def mesh_co_edges(me):
    m = me.data
    co = np.empty(len(m.vertices) * 3)
    m.vertices.foreach_get('co', co)
    ev = np.empty(len(m.edges) * 2, dtype=np.int64)
    m.edges.foreach_get('vertices', ev)
    return co.reshape(-1, 3), ev.reshape(-1, 2)


def read_weights(me):
    names = [g.name for g in me.vertex_groups]
    W = np.zeros((len(me.data.vertices), len(names)))
    for v in me.data.vertices:
        for g in v.groups:
            W[v.index, g.group] = g.weight
    return names, W


def leg_dist(co):
    """到真正的腿中心線的水平距離"""
    x, y, z = co.T
    return np.hypot(np.abs(x) - np.interp(z, LEG_Z, LEG_X), y - np.interp(z, LEG_Z, LEG_Y))


def segment_cloth(me):
    """多源測地線分區（Meshy 的網格是單一連通塊）：腿 / 身體 / 裙擺 / 垂袖。
    種子：腿＝腿中心線附近的膚色（大腿）與靴子；裙擺＝遠離腿、帶腿骨權重的布料；垂袖＝手臂權重的垂片與最外側"""
    co, ev = mesh_co_edges(me)
    names, W = read_weights(me)
    gi = {k: i for i, k in enumerate(names)}
    wl = W[:, [gi[k] for k in leg_names(me)]].sum(1)
    wa = W[:, [gi[k] for k in names if 'Arm' in k or 'Hand' in k]].sum(1)
    wf = W[:, [gi[k] for k in names if 'Foot' in k or 'Toe' in k]].sum(1)
    skin = skin_vertices(me)
    x, y, z = co.T
    ax = np.abs(x)
    dleg = leg_dist(co)
    # 頭髮：軀幹後方（背部表面在 y ≈ -0.06）、肩膀以下、不帶腿 / 手臂權重的非膚色頂點（一撮一撮獨立的髮束）
    upper = (wl < 0.05) & (wa < 0.3)
    hair = upper & ~skin & (y > -0.02) & (z > 0.95) & (z < 1.36) & (ax < 0.2)
    # 確定是身體的：膚色、身體前半、頭部、腰以下、兩側；其餘（貼著背的髮束）由測地線距離決定
    torso = upper & ~hair & (skin | (y < -0.06) | (z > 1.40) | (z < 0.93) | (ax > 0.2))
    seeds = [
        (skin & (dleg < 0.075) & (z > 0.38) & (z < 0.9)) | ((z < 0.42) & (dleg < 0.058)) | (wf > 0.3),
        torso | (skin & (z > 0.86) & (z < 1.02) & (ax < 0.17) & (np.abs(y + 0.07) < 0.12)),
        (wl > 0.2) & ~skin & (dleg > 0.11) & ((z < 0.42) | ((ax < 0.22) & (z < 0.9))),
        ((wa > 0.5) & (z < 1.26) & (ax > 0.2) & ~skin) | ((ax > 0.36) & (z > 0.6) & (z < 1.2) & (wl > 0.2)),
        hair,
    ]
    import heapq
    n = len(co)
    adj = [[] for _ in range(n)]
    el = np.linalg.norm(co[ev[:, 0]] - co[ev[:, 1]], axis=1)
    for (a, b), d in zip(ev.tolist(), el.tolist()):
        adj[a].append((b, d))
        adj[b].append((a, d))
    lab = np.full(n, 1)
    dist = np.full(n, np.inf)
    h = []
    for L, mk in enumerate(seeds):
        for v in np.nonzero(mk)[0]:
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
    print('[violinist] segment', {k: int((lab == i).sum()) for i, k in enumerate(SEG_LABELS)})
    return lab


def cut_cloth_bridges(me, lab):
    """腿與布料接觸處被 Meshy 融合成的「橋接面」：腿一動就被拉成長條，直接切開（接觸處本來就互相遮住）"""
    LEG = SEG_LABELS.index('LEG')
    BODY, HAIR = SEG_LABELS.index('BODY'), SEG_LABELS.index('HAIR')
    cloth = (SEG_LABELS.index('SKIRT'), SEG_LABELS.index('SLEEVE'))
    bm = bmesh.new()
    bm.from_mesh(me.data)
    layer = bm.verts.layers.int.new('orig')
    for v in bm.verts:
        v[layer] = v.index
    kill = []
    for f in bm.faces:
        ls = {int(lab[v.index]) for v in f.verts}
        if LEG in ls and any(c in ls for c in cloth):
            kill.append(f)
        elif HAIR in ls and (any(c in ls for c in cloth) or (BODY in ls and f.calc_center_median().z < HAIR_ROOT[0])):
            # 髮束黏在背上 / 垂袖 / 裙腰的融合面（髮根以上是頭髮本身的連接，不切）
            kill.append(f)
        elif ls == {LEG} and f.calc_center_median().z < 0.8:
            # 左右靴子 / 大腿內側互相融合的面（胯下以上是連續的身體，不切）。分側規則與 fix_knees 相同：x > 0 為左
            if len({v.co.x > 0 for v in f.verts}) == 2:
                kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.verts.ensure_lookup_table()
    orig = np.array([v[layer] for v in bm.verts])
    bm.verts.layers.int.remove(layer)
    bm.to_mesh(me.data)
    bm.free()
    me.data.update()
    print(f'[violinist] cut {len(kill)} bridge faces (leg-cloth, left-right leg, hair-body)')
    return lab[orig]


def fix_knees(rig, me, lab):
    """膝關節移到真正的腿中心（該高度腿部頂點外框的中心），並依新的膝蓋高度重分大腿 / 小腿權重"""
    co, _ = mesh_co_edges(me)
    LEG = lab == SEG_LABELS.index('LEG')
    knees = {}
    for S, s in (('Left', 1), ('Right', -1)):
        m = LEG & (co[:, 0] * s > 0) & (np.abs(co[:, 2] - KNEE_Z) < 0.03)
        lo, hi = co[m].min(0), co[m].max(0)
        knees[S] = Vector(((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, KNEE_Z))
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    eb = rig.data.edit_bones
    for S, k in knees.items():
        old = eb[f'{S}Leg'].head.copy()
        foot = eb[f'{S}Foot'].head.copy()
        eb[f'{S}UpLeg'].tail = k
        eb[f'{S}Leg'].head = k
        eb[f'{S}Leg'].tail = foot
        # 骨頭軸向改變後 roll 以「膝蓋朝前」重設（動作一律以世界軸 / IK 產生，不依賴 roll，但保持一致）
        eb[f'{S}UpLeg'].align_roll(FWD)
        eb[f'{S}Leg'].align_roll(FWD)
        print(f'[violinist] knee {S}: {tuple(round(v, 3) for v in old)} -> {tuple(round(v, 3) for v in k)}')
    bpy.ops.object.mode_set(mode='OBJECT')
    # 腿部頂點：同側「大腿 + 小腿」的總權重依高度重新分配（腳踝以下維持 Mixamo 的權重）
    names, W = read_weights(me)
    gi = {k: i for i, k in enumerate(names)}
    z = co[:, 2]
    kn = smoothstep_np(KNEE_Z - 0.05, KNEE_Z + 0.05, z)
    # 胯下以下的腿部頂點只跟自己那一側的腿：Mixamo 在兩腿靠近處（靴子內側、大腿內側）混了對側的權重，兩腳一分開就被扯過去
    PARTS = ('UpLeg', 'Leg', 'Foot', 'ToeBase')
    for i in np.nonzero(LEG & (z < 0.78))[0]:
        i = int(i)
        S, O = ('Left', 'Right') if co[i, 0] > 0 else ('Right', 'Left')
        for part in PARTS:
            w = float(W[i, gi[O + part]])
            if w > 1e-4:
                me.vertex_groups[O + part].remove([i])
                W[i, gi[S + part]] += w
                W[i, gi[O + part]] = 0.0
                me.vertex_groups[S + part].add([i], float(W[i, gi[S + part]]), 'REPLACE')
    idx = np.nonzero(LEG & (z > 0.2))[0]
    for S in ('Left', 'Right'):
        up, lo = me.vertex_groups[f'{S}UpLeg'], me.vertex_groups[f'{S}Leg']
        tot = W[:, gi[f'{S}UpLeg']] + W[:, gi[f'{S}Leg']]
        for i in idx:
            t = float(tot[i])
            if t < 1e-4:
                continue
            k = float(kn[i])
            up.add([int(i)], t * k, 'REPLACE')
            lo.add([int(i)], t * (1 - k), 'REPLACE')


def add_cloth_bones(rig, me, lab):
    """依實際布料形狀建立彈簧骨鏈：裙擺每個方向取該扇形布料半徑的中位附近，垂袖取各高度的質心"""
    co, _ = mesh_co_edges(me)
    sk = co[lab == SEG_LABELS.index('SKIRT')]
    rel = sk[:, :2] - np.array(SKIRT_C)
    ang = np.degrees(np.arctan2(rel[:, 0], -rel[:, 1]))
    rad = np.linalg.norm(rel, axis=1)
    table = []
    for name, a in SKIRT_DIRS:
        da = np.abs((ang - a + 180) % 360 - 180)
        ar = math.radians(a)
        pts = []
        for i, zz in enumerate(SKIRT_Z):
            m = (da < 28) & (np.abs(sk[:, 2] - zz) < 0.07)
            r = float(np.percentile(rad[m], 55)) if m.sum() > 12 else None
            pts.append(r)
        # 沒有布料的高度（正面開衩）沿用上一節的半徑外推，至少不小於腰部半徑
        for i in range(len(pts)):
            if pts[i] is None:
                pts[i] = (pts[i - 1] + 0.03) if i > 0 and pts[i - 1] else 0.16
            pts[i] = max(pts[i], 0.13)
        nodes = [Vector((SKIRT_C[0] + math.sin(ar) * r, SKIRT_C[1] - math.cos(ar) * r, zz)) for r, zz in zip(pts, SKIRT_Z)]
        table.append((f'skirt_{name}', nodes, 'Hips'))
    sl = co[lab == SEG_LABELS.index('SLEEVE')]
    for S, s in (('L', 1), ('R', -1)):
        side = sl[sl[:, 0] * s > 0.18]
        nodes = []
        for zz in DRAPE_Z:
            m = np.abs(side[:, 2] - zz) < 0.08
            c = side[m].mean(0) if m.sum() > 8 else (nodes[-1] if nodes else Vector((s * 0.33, -0.05, zz)))
            nodes.append(Vector((float(c[0]), float(c[1]), zz)))
        table.append((f'drape_{S}', nodes, 'Spine2'))
    hr = co[lab == SEG_LABELS.index('HAIR')]
    for name, hx in HAIR_X:
        nodes = []
        for zz in HAIR_Z:
            m = (np.abs(hr[:, 2] - zz) < 0.07) & (np.abs(hr[:, 0] - hx) < 0.08)
            yy = float(np.median(hr[m, 1])) if m.sum() > 8 else (nodes[-1].y if nodes else 0.03)
            nodes.append(Vector((hx * (1 + 0.15 * len(nodes)), yy, zz)))
        table.append((f'hair_{name}', nodes, 'Spine2'))
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    eb = rig.data.edit_bones
    for prefix, nodes, parent in table:
        prev = parent
        for i in range(len(nodes) - 1):
            b = eb.new(f'{prefix}{i + 1}')
            b.head, b.tail = nodes[i], nodes[i + 1]
            b.parent = eb[prev]
            b.use_connect = i > 0
            b.use_deform = True
            prev = b.name
    bpy.ops.object.mode_set(mode='OBJECT')
    print('[violinist] cloth bones', sum(len(n) - 1 for _, n, _ in table))
    return table


def cloth_weights(me, lab, table):
    """布料頂點的「腿骨權重」改分給彈簧骨鏈（其餘權重——骨盆、脊椎、手臂——維持 Mixamo 的結果）：
      裙擺：角度在相鄰兩條鏈之間線性混合、高度沿鏈以帽形函數混合；腰際交回 Hips；貼近大腿的保留一部分大腿權重
      垂袖：沿鏈的高度混合"""
    co, ev = mesh_co_edges(me)
    names, W = read_weights(me)
    n = len(co)
    gi = {k: i for i, k in enumerate(names)}
    x, y, z = co.T
    legs = leg_names(me)
    wl = W[:, [gi[k] for k in legs]].sum(1)
    SK, SL = lab == SEG_LABELS.index('SKIRT'), lab == SEG_LABELS.index('SLEEVE')
    HR = lab == SEG_LABELS.index('HAIR')
    new = {}

    def add(name, w):
        new[name] = new.get(name, 0) + w

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

    # 裙擺
    kh = smoothstep_np(0.9, 1.0, z)  # 腰際 → Hips
    dsurf = leg_dist(co) - 0.055
    kth = 0.35 * (1 - smoothstep_np(0.015, 0.07, dsurf)) * smoothstep_np(KNEE_Z, KNEE_Z + 0.15, z)
    share = wl * SK
    add('Hips', share * kh)
    for S, s in (('Left', 1), ('Right', -1)):
        add(f'{S}UpLeg', share * (1 - kh) * kth * (x * s > 0))
    chain = share * (1 - kh) * (1 - kth)
    rel = co[:, :2] - np.array(SKIRT_C)
    ang = np.degrees(np.arctan2(rel[:, 0], -rel[:, 1]))
    nseg = len(SKIRT_Z) - 1
    tt = np.interp(-z, -np.array(SKIRT_Z), np.arange(nseg + 1))
    hz = hats(tt, nseg)
    step = 360 / len(SKIRT_DIRS)
    for name, a in SKIRT_DIRS:
        wa = np.clip(1 - np.abs((ang - a + 180) % 360 - 180) / step, 0, 1)
        for j in range(nseg):
            add(f'skirt_{name}{j + 1}', chain * wa * hz[j])
    # 垂袖
    nseg = len(DRAPE_Z) - 1
    tt = np.interp(-z, -np.array(DRAPE_Z), np.arange(nseg + 1))
    hz = hats(tt, nseg)
    for S, s in (('L', 1), ('R', -1)):
        share = wl * SL * (x * s > 0)
        for j in range(nseg):
            add(f'drape_{S}{j + 1}', share * hz[j])

    # 頭髮：髮根以下整個交給髮鏈（x 方向在相鄰兩條之間混合、沿高度混合）；原本的權重（頭 / 脊椎）依比例縮小
    kroot = (1 - smoothstep_np(HAIR_ROOT[0], HAIR_ROOT[1], z)) * HR
    hx = np.array([v for _, v in HAIR_X])
    nseg = len(HAIR_Z) - 1
    tt = np.interp(-z, -np.array(HAIR_Z), np.arange(nseg + 1))
    hz = hats(tt, nseg)
    for i, (name, v) in enumerate(HAIR_X):
        wx = np.clip(1 - np.abs(x - v) / abs(hx[1] - hx[0]), 0, 1)
        if i == 0:
            wx = np.where(x > v, 1.0, wx)
        if i == len(HAIR_X) - 1:
            wx = np.where(x < v, 1.0, wx)
        for j in range(nseg):
            add(f'hair_{name}{j + 1}', kroot * wx * hz[j])

    # 在布料頂點之間平滑幾次（分區邊界、鏈與鏈之間不要有折痕），再與原本的非腿骨權重合併
    cloth = SK | SL | HR
    M = np.stack([new[k] for k in new], 1)
    order = list(new)
    a, b = ev[:, 0], ev[:, 1]
    both = cloth[a] & cloth[b]
    a, b = a[both], b[both]
    for _ in range(3):
        acc = M.copy()
        deg = np.ones(n)
        np.add.at(acc, a, M[b])
        np.add.at(acc, b, M[a])
        np.add.at(deg, a, 1)
        np.add.at(deg, b, 1)
        sm = acc / deg[:, None]
        # 平滑不改變每個頂點分給布料骨的總量
        tot0, tot1 = M.sum(1), sm.sum(1)
        M = np.where(cloth[:, None], sm * (tot0 / np.maximum(tot1, 1e-9))[:, None], M)
    for k in order:
        if k not in me.vertex_groups:
            me.vertex_groups.new(name=k)
    leg_groups = [me.vertex_groups[k] for k in legs]
    idx = np.nonzero(cloth & ((wl > 1e-4) | (kroot > 1e-4)))[0]
    keep = [k for k in names if k not in legs]
    for i in idx:
        i = int(i)
        scale = 1.0 - float(kroot[i])  # 頭髮：原本的權重讓位給髮鏈
        cand = [(k, float(W[i, gi[k]]) * scale) for k in keep if W[i, gi[k]] > 1e-3]
        acc = {}
        for k, w in cand:
            acc[k] = acc.get(k, 0.0) + w
        for j, k in enumerate(order):
            w = float(M[i, j])
            if w > 1e-3:
                acc[k] = acc.get(k, 0.0) + w
        top = sorted(acc.items(), key=lambda kv: -kv[1])[:4]
        tot = sum(w for _, w in top) or 1.0
        for g in leg_groups:
            g.remove([i])
        for k in list(acc):
            me.vertex_groups[k].remove([i])
        for k, w in top:
            me.vertex_groups[k].add([i], w / tot, 'REPLACE')
    print(f'[violinist] cloth weights: {len(idx)} verts re-skinned to {len(order)} bones')
    blend_cloth_boundary(me, lab)
    limit_influences(me)


def blend_cloth_boundary(me, lab, rings=4, iters=6):
    """臀部一帶「跟著骨盆 / 大腿的身體」緊鄰「跟著裙擺鏈的布料」：權重在一個面之內跳變，大腿一擺就把那一圈面扯長。
    在交界兩側各 rings 圈頂點的範圍內，對完整的權重向量做拉普拉斯平滑，把形變攤開"""
    co, ev = mesh_co_edges(me)
    names, W = read_weights(me)
    n = len(co)
    SK = lab == SEG_LABELS.index('SKIRT')
    BD = lab == SEG_LABELS.index('BODY')
    a, b = ev[:, 0], ev[:, 1]
    cross = (SK[a] & BD[b]) | (SK[b] & BD[a])
    band = np.zeros(n, dtype=bool)
    band[a[cross]] = True
    band[b[cross]] = True
    band &= co[:, 2] < 1.02
    for _ in range(rings - 1):
        grow = band.copy()
        grow[a[band[b]]] = True
        grow[b[band[a]]] = True
        band = grow & (SK | BD) & (co[:, 2] < 1.02)
    M = W.copy()
    for _ in range(iters):
        acc = M.copy()
        deg = np.ones(n)
        np.add.at(acc, a, M[b])
        np.add.at(acc, b, M[a])
        np.add.at(deg, a, 1)
        np.add.at(deg, b, 1)
        M = np.where(band[:, None], acc / deg[:, None], M)
    groups = [me.vertex_groups[k] for k in names]
    for i in np.nonzero(band)[0]:
        i = int(i)
        row = M[i]
        top = np.argsort(-row)[:4]
        tot = float(row[top].sum()) or 1.0
        for j in np.nonzero(W[i] > 0)[0]:
            groups[int(j)].remove([i])
        for j in top:
            if row[j] > 1e-3:
                groups[int(j)].add([i], float(row[j]) / tot, 'REPLACE')
    print(f'[violinist] blended {int(band.sum())} verts around the body-skirt boundary')


def rig_cloth(rig, me):
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix()
    bpy.context.view_layer.update()
    lab = segment_cloth(me)
    lab = cut_cloth_bridges(me, lab)
    fix_knees(rig, me, lab)
    table = add_cloth_bones(rig, me, lab)
    cloth_weights(me, lab, table)


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
    keyed = [b.name for b in bones if b.name not in ('headfront', 'HeadTop_End') and not b.name.startswith(CLOTH_PREFIX)]
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

    def leg(P, S, ankle, pole=FWD, flat=True, pitch=0.0):
        ik(P, f'{S}UpLeg', f'{S}Leg', LL[S]['up'], LL[S]['lo'], ankle, pole)
        if flat:  # 腳掌維持 rest 的世界方向（高跟鞋貼地）；pitch > 0 腳尖下壓（度）
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
        # 琴身接近水平、琴尾在鎖骨的高度：下巴在琴的上方，整張臉露出來（原本舉在嘴巴 / 眼睛的高度，把臉擋住）
        d = Vector((0.55, -0.82, 0.06)).normalized()
        tail = Vector((0.055, -0.085, chin.z - 0.05))
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

    # ── 步態（取代 Mixamo 的 Walking / Running：那是運動員式的大步衝刺，甩著琴與弓、上身前傾駝背）──
    def gait(frames, speed, stance, lift, lean, twist, sway, narrow, pose_arms, flight=0.0, dip=0.012, toe=14.0, bob=1.0):
        """IK 步態：支撐腳鎖在地面、以 speed（m/s，timeScale=1 時）往後移動 → 遊戲依實際速度調整播放速率就不滑步。
        骨盆高度＝支撐腳（留一點彎曲）碰得到地面的最高位置；騰空期在前後支撐之間內插並加上小跳。
        narrow：兩腳往中線收的比例（走一直線的貓步）；pose_arms(t, P, a)：上肢與道具"""
        cyc = frames / FPS
        D = speed * stance * cyc  # 支撐期內腳相對骨盆往後移的距離
        hip0 = {S: head0[f'{S}UpLeg'] for S in ('Left', 'Right')}

        def foot(S, t):
            p = (t + (0.0 if S == 'Left' else 0.5)) % 1.0
            a = ANK[S]
            if p < stance:
                fwd, h, q = D / 2 - p / stance * D, 0.0, None
            else:
                q = (p - stance) / (1 - stance)
                e = (1 - math.cos(math.pi * q)) / 2
                fwd, h = -D / 2 + e * D, lift * math.sin(math.pi * q) ** 0.9
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
        # 骨盆起伏壓小（bob < 1）：裙襬下的腳步輕、上身平穩滑行
        zmax = max(dz)
        dz = [zmax - (zmax - v) * bob for v in dz]

        def f(t, P):
            a, c = Sn(t * TAU), Cs(t * TAU)
            x = t * N
            i0 = int(x) % N
            z = dz[i0] + (dz[(i0 + 1) % N] - dz[i0]) * (x - int(x))
            # 骨盆：跟著跨步左右扭、重心移向支撐腳；軀幹反向扭回來，頭保持朝前、下巴微收
            hips(P, (0.006 * sway * c, 0, z - SINK), (Z, twist * a), (Y, sway * c), (X, lean * 0.35))
            P['Spine'].rotation_quaternion = R('Spine', (Z, -twist * 0.5 * a), (X, lean * 0.3))
            P['Spine1'].rotation_quaternion = R('Spine1', (Z, -twist * 0.4 * a), (Y, -sway * 0.5 * c), (X, lean * 0.2))
            P['Spine2'].rotation_quaternion = R('Spine2', (Z, -twist * 0.3 * a), (X, lean * 0.15))
            P['Neck'].rotation_quaternion = R('Neck', (X, -lean * 0.35))
            P['Head'].rotation_quaternion = R('Head', (Z, twist * 0.2 * a), (X, -lean * 0.4))
            for S in ('Left', 'Right'):
                tgt, q = foot(S, t)
                tgt.z -= SINK
                # 擺動期：離地時腳尖下壓、落地前收平；膝蓋朝前略往內（不外八）
                pitch = toe * math.sin(math.pi * q) * (1 - q) * 2 if q is not None else 0.0
                leg(P, S, tgt, (0.08 if S == 'Left' else -0.08, -1, 0.1), pitch=pitch)
            pose_arms(t, P, a)
        return f

    def carry_arms(swing, back, lift_bow):
        """步行 / 奔跑的上肢：不擺臂（手上是琴與弓）。左手把小提琴提在身側、右手持弓斜向後下方，隨步伐小幅擺動"""
        def f(t, P, a):
            upd()
            for S, s in (('Left', 1), ('Right', -1)):
                sh = P[f'{S}Arm'].head.copy()
                k = a * s  # 與對側腳同步
                # 手肘微彎、略離開身體，手腕自然下垂（指尖朝下略往後）；隨步伐前後小幅擺動
                hand = sh + Vector((s * (0.13 + 0.008 * k), back + 0.02 + 0.04 * swing * k, -0.262 + 0.01 * swing * abs(a) + (lift_bow if S == 'Right' else 0.0)))
                arm(P, S, hand, (s * 0.35, 0.9, 0.0), wrist=(s * 0.02, 0.12 + back * 0.5, -1))
            hang(P)
        return f

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
        # 頭往左傾、轉向琴，只微微低頭（低太多下巴會埋進琴身）
        P['Neck'].rotation_quaternion = R('Neck', (Y, 10), (X, 2))
        P['Head'].rotation_quaternion = R('Head', (Y, 14 + 2 * sway), (Z, 12), (X, 3))
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
    # 走路：小步、兩腳收向中線、上身挺直；奔跑：輕盈的小跳步、上身只微微前傾，手臂收在身後
    # 骨盆起伏要小（bob）：支撐期腳掌前後移動的距離越長，腿伸直也碰不到地、骨盆就得下沉越多。
    # 奔跑用短支撐、長騰空的輕跳步（支撐期只佔 24%），骨盆上下約 4 cm；原本支撐 36% 時每步起伏 17 cm，像在彈跳
    make('Walk', WALK_FRAMES, gait(WALK_FRAMES, WALK_REF, 0.6, 0.05, 2.5, 5, 2.5, 0.55, carry_arms(1.0, 0.0, 0.0), bob=0.5), 1, ground=False)
    make('Run', RUN_FRAMES, gait(RUN_FRAMES, RUN_REF, 0.24, 0.12, 9, 7, 2.5, 0.8, carry_arms(0.6, 0.11, 0.02), flight=0.02, dip=0.02, toe=24, bob=0.55), 1, ground=False)
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


def save_hires(img, name='violet_color_4k.webp'):
    """原尺寸貼圖另存 WebP（public/models/violinist/），桌機放大時看得到細節"""
    cwebp = shutil.which('cwebp')
    if not cwebp:
        print('[violinist] 找不到 cwebp，略過 4K 貼圖')
        return
    os.makedirs(OUT_GLB, exist_ok=True)
    tmp = os.path.join(OUT_BLEND, 'hires_tmp.png')
    os.makedirs(OUT_BLEND, exist_ok=True)
    hi = img.copy()
    if hi.size[0] > HIRES_SIZE:
        hi.scale(HIRES_SIZE, HIRES_SIZE)
    hi.filepath_raw = tmp
    hi.file_format = 'PNG'
    hi.save()
    bpy.data.images.remove(hi)
    out = os.path.join(OUT_GLB, name)
    subprocess.run([cwebp, '-quiet', '-q', str(HIRES_QUALITY), '-m', '6', '-sharp_yuv', tmp, '-o', out], check=True)
    os.remove(tmp)
    print('[violinist] hires', out, os.path.getsize(out) // 1024, 'KB')


def mesh_bbox(ob):
    co = np.empty(len(ob.data.vertices) * 3)
    ob.data.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3) @ np.array(ob.matrix_world)[:3, :3].T + np.array(ob.matrix_world)[:3, 3]
    return co.min(0), co.max(0)


def load_high(me):
    """匯入 384 萬面的高模，對齊到低模（Meshy 的綁骨模型是同一個高模原地減面而來，只差一個等比縮放：
    正規化成 1.7 m 高、腳底在 z=0）。以兩者外框對齊後表面誤差平均 0.15 mm、最大 0.9 mm"""
    if not os.path.exists(SRC_HIGH):
        print('[violinist] 找不到高模，略過面方向校正與法線貼圖烘焙', SRC_HIGH)
        return None
    with bpy.data.libraries.load(SRC_HIGH) as (src, dst):
        dst.objects = [n for n in src.objects]
    high = next(o for o in dst.objects if o and o.type == 'MESH')
    for o in dst.objects:
        if o and o is not high:
            bpy.data.objects.remove(o, do_unlink=True)
    bpy.context.scene.collection.objects.link(high)
    llo, lhi = mesh_bbox(me)
    hlo, hhi = mesh_bbox(high)
    k = float((lhi[2] - llo[2]) / (hhi[2] - hlo[2]))
    high.matrix_world = Matrix.Translation(Vector((llo + lhi) / 2)) @ Matrix.Scale(k, 4) @ Matrix.Translation(Vector(-(hlo + hhi) / 2))
    high.hide_render = True
    print(f'[violinist] high poly {len(high.data.polygons)} faces, scale {k:.4f}')
    return high


def high_reference(high):
    """高模的 BVH 與面法線（世界座標），用來校正低模的面方向"""
    from mathutils.bvhtree import BVHTree
    bm = bmesh.new()
    bm.from_mesh(high.data)
    bm.transform(high.matrix_world)
    bm.normal_update()
    bm.faces.ensure_lookup_table()
    normals = [f.normal.copy() for f in bm.faces]
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    return tree, normals


def orient_to_high(bm, ref):
    """Meshy 減面後約 6% 的三角形方向是反的（法線朝內）。反向的面與相鄰的面共用頂點，平滑法線互相抵銷，
    整塊布料 / 頭髮的光影都會錯，烘焙法線貼圖時也會整個 UV 島變黑。
    （焊接後）先以拓撲讓每個相連區塊內的方向一致，再以面積加權投票（比對最近的高模表面）決定整塊的朝向。
    不逐面比對高模：臉等處高模很薄，最近點可能落在另一側，逐面翻會在臉上翻出破洞"""
    tree, normals = ref
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    seen = set()
    flipped = 0
    for f0 in bm.faces:
        if f0.index in seen:
            continue
        comp, stack = [], [f0]
        seen.add(f0.index)
        while stack:
            f = stack.pop()
            comp.append(f)
            for e in f.edges:
                if len(e.link_faces) != 2:
                    continue  # 非流形邊不跨越：與 recalc_face_normals 的區塊劃分一致
                for g in e.link_faces:
                    if g.index not in seen:
                        seen.add(g.index)
                        stack.append(g)
        vote = 0.0
        for f in comp:
            _, _, i, d = tree.find_nearest(f.calc_center_median())
            if i is not None and d < 0.003:
                vote += f.calc_area() * (1 if f.normal.dot(normals[i]) > 0 else -1)
        if vote < 0:
            for f in comp:
                f.normal_flip()
            flipped += len(comp)
    print(f'[violinist] orient: flipped {flipped} faces')


def bake_normals(rig, me, high):
    """由高模烘焙切線空間法線貼圖到低模 LOD0（rest pose）。結果快取成 PNG，
    來源比快取新或 VIOLINIST_REBAKE=1 時才重烘"""
    cache = os.path.join(OUT_BLEND, BAKE_CACHE)
    fresh = os.path.exists(cache) and os.path.getmtime(cache) > max(os.path.getmtime(SRC_HIGH), os.path.getmtime(SRC_CHAR), os.path.getmtime(__file__))
    if fresh and os.environ.get('VIOLINIST_REBAKE') != '1':
        img = bpy.data.images.load(cache)
        img.colorspace_settings.name = 'Non-Color'
        print('[violinist] normal bake (cached)', cache)
        return img
    if high is None:
        return None
    import time
    t0 = time.time()
    high.hide_render = False
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
                    print('[violinist] bake device', dev_type)
                    break
            except TypeError:
                continue
    except Exception as e:  # 沒有 GPU 就用 CPU
        print('[violinist] bake on CPU', e)
    sc.cycles.samples = 1
    rig.data.pose_position = 'REST'

    img = bpy.data.images.new('violet_normal_bake', BAKE_SIZE, BAKE_SIZE, alpha=False, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    mat = me.data.materials[0]
    node = mat.node_tree.nodes.new('ShaderNodeTexImage')
    node.image = img
    mat.node_tree.nodes.active = node

    bpy.ops.object.select_all(action='DESELECT')
    high.select_set(True)
    me.select_set(True)
    bpy.context.view_layer.objects.active = me
    bake = sc.render.bake
    bake.use_selected_to_active = True
    bake.cage_extrusion = BAKE_CAGE
    bake.max_ray_distance = BAKE_RAY
    bake.margin = 16
    bake.normal_space = 'TANGENT'
    bpy.ops.object.bake(type='NORMAL')
    rig.data.pose_position = 'POSE'
    mat.node_tree.nodes.remove(node)

    high.hide_render = True
    clean_normal_bake(img)
    os.makedirs(OUT_BLEND, exist_ok=True)
    img.filepath_raw = cache
    img.file_format = 'PNG'
    sc.render.image_settings.color_depth = '16'
    img.save()
    out = bpy.data.images.load(cache)
    out.colorspace_settings.name = 'Non-Color'
    bpy.data.images.remove(img)
    print(f'[violinist] normal bake {time.time() - t0:.0f}s -> {cache}')
    return out


def clean_normal_bake(img):
    """切線空間法線不可能朝向表面後方（z < 0）：那是光線打到薄布料 / 髮片另一側的失敗樣本。
    z 低於門檻的像素淡回平面法線 (0, 0, 1)，避免身上出現黑斑"""
    px = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    n = px[:, :3] * 2 - 1
    k = smoothstep_np(0.05, 0.35, n[:, 2])[:, None]
    n = n * k + np.array((0, 0, 1), dtype=np.float32) * (1 - k)
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-6)
    print(f'[violinist] normal bake cleaned {(k[:, 0] < 0.99).mean() * 100:.1f}% px')
    px[:, :3] = n * 0.5 + 0.5
    img.pixels.foreach_set(px.ravel())
    img.update()


def use_normal_map(me, nimg):
    """法線貼圖接上 M_Violet：4K 另存 WebP（桌機延遲載入），GLB 內縮成 2048"""
    save_hires(nimg, 'violet_normal_4k.webp')
    img = nimg.copy()
    img.name = 'violet_normal'
    if img.size[0] > TEX_SIZE:
        img.scale(TEX_SIZE, TEX_SIZE)
    mat = me.data.materials[0]
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tex.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])


def limit_influences(ob, n=4):
    """每個頂點只保留最大的 n 個權重並正規化（遊戲端的蒙皮每個頂點最多 4 根骨頭）"""
    for v in ob.data.vertices:
        gs = sorted(((g.group, g.weight) for g in v.groups), key=lambda x: -x[1])
        keep = gs[:n]
        tot = sum(w for _, w in keep) or 1.0
        for g, _ in gs[n:]:
            ob.vertex_groups[g].remove([v.index])
        for g, w in keep:
            ob.vertex_groups[g].add([v.index], w / tot, 'REPLACE')


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
    # 減面可能留下退化的面：清掉，否則匯出器會警告網格不合法
    lod1.data.validate(clean_customdata=False)
    # 減面會內插權重：每個頂點只保留最大的 4 個並正規化
    limit_influences(lod1)
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
        export_tangents=True,  # 法線貼圖的切線空間與 Blender 烘焙一致（MikkTSpace）；沒有切線時 three 會改用螢幕空間導數
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
    high = load_high(me)  # 在焊接 / 細分改變外框之前對齊
    weld_and_smooth(me, high_reference(high) if high else None)
    fidx = foot_verts(me)
    z0 = me.data.vertices[0].co.z
    ground(rig, me, fidx)
    if high:
        # 網格是骨架的子物件，ground() 會讓網格資料實際位移 2×dz：以實測位移對齊高模
        high.matrix_world = Matrix.Translation((0, 0, me.data.vertices[0].co.z - z0)) @ high.matrix_world
    remove_inner_face_layer(me)  # FACE_CENTER 是接地後的座標
    fidx = foot_verts(me)  # 刪面會一併移除孤立頂點，頂點索引改變
    face_normals(me)
    nimg = bake_normals(rig, me, high)  # 在最終拓撲 / 法線上烘焙（切線空間要與匯出的一致）
    if high:
        hm = high.data
        bpy.data.objects.remove(high, do_unlink=True)
        bpy.data.meshes.remove(hm)
    # Mixamo 的 Walking / Running 不再使用（膝關節校正後也不適用）：改由 build_actions 產生
    for name in ('Walk', 'Run'):
        if name in bpy.data.actions:
            bpy.data.actions.remove(bpy.data.actions[name])
    rig_cloth(rig, me)
    fidx = foot_verts(me)  # 切開橋接面會移除孤立頂點，頂點索引改變
    add_prop_bones(rig)
    violin = load_violin()
    attach(violin, rig, 'prop_violin')
    bow = build_bow()
    attach(bow, rig, 'prop_bow')
    prep_material(me)
    if nimg:
        use_normal_map(me, nimg)
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
    print(f'[violinist] VIOLINIST_GAIT_REF = {{ Walk: {WALK_REF:.2f}, Run: {RUN_REF:.2f} }}')


if __name__ == '__main__' or __name__ == '<run_path>' or __name__ == 'builtins':
    main(do_export=os.environ.get('VIOLINIST_NO_EXPORT') != '1')
