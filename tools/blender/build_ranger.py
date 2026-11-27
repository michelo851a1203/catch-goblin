"""
Catch Goblin — 遊俠精靈（長笛遊俠）：Meshy.ai 綁骨模型 → 正規化 / 手指骨 / 長笛 / 程序化動作 / LOD / 匯出

所有精靈都以樂器作為攻擊手段：遊俠吹奏長笛召喚箭矢、藤蔓陷阱與收網的繩索，手上沒有弓。

來源（Meshy.ai 產出，放在 repo 外層的 assets/assets_遊俠精靈/）：
    elf-woman-idle-walk-run.glb                              角色（Meshy 骨架 24 根 + 權重，約 3.1 萬面，4K 色彩 / 金屬粗糙 / 法線貼圖）
    Meshy_AI_elven_magical_flute_*_image-to-3d-texture.glb   長笛（64 萬面，減面後使用）

用法：
    blender -b -P tools/blender/build_ranger.py
    （RANGER_ASSET_DIR 指定素材資料夾；RANGER_PREVIEW=1 另外輸出各動作的預覽圖（RANGER_PREVIEW_CLIPS=Run,Walk 只輸出指定動作）；
      RANGER_NO_EXPORT=1 不匯出 GLB）

輸出：
    public/models/ranger/ranger.glb          LOD0 + LOD1 共用骨架、長笛（掛在 prop_flute 骨）、10 個動作
    public/models/ranger/ranger_color_4k.webp / ranger_normal_4k.webp   桌機延遲載入的原尺寸貼圖
    tools/blender/out/ranger.blend

流程（焊接、臉部法線、LOD 等共用 build_violinist.py 的函式）：
  1. 匯入、套用 0.01 縮放、骨頭改成 Mixamo 命名（Spine02 / Spine01 / Spine / neck → Spine / Spine1 / Spine2 / Neck，
     遊戲端的碰撞體與其他精靈共用骨名）
  2. 手指骨：Meshy 的手只有一根手骨、手指是直的。每隻手加兩節「四指」骨（指根 / 指節），依沿手軸的位置分配權重，
     握長笛時四指才彎得起來包住笛身（否則笛子只是貼在攤平的手掌上）
  3. 長笛減面後掛在 prop_flute（右手的子骨）。右手與長笛的相對關係在所有動作中固定（握在同一個位置），
     所以只要決定長笛的位置，右手就跟著決定；吹奏時左手再握上去
  4. 以「世界軸 + 相對 rest」與兩骨 IK 產生所有動作。她穿牛仔褲，腿完全看得到：
     步態的擺動腳用 Hermite 曲線（離地、落地時與地面速度一致，不會頓一下）、蹬地時腳跟先離地、擺動時小腿往後收
  5. LOD1 減面、貼圖縮小為 WebP、匯出 GLB（EXT_meshopt_compression，含 MikkTSpace 切線）
"""
import bpy, bmesh, math, os, sys
import numpy as np
from mathutils import Vector, Quaternion, Matrix

try:
    HERE = os.path.dirname(os.path.abspath(__file__))
except NameError:
    HERE = '/Users/michaelho/main/project/2026-10-20-side-hustle/goblin-game/tools/blender'
sys.path.insert(0, HERE)
import build_violinist as bv  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
ASSET_DIR = os.environ.get('RANGER_ASSET_DIR', os.path.join(os.path.dirname(REPO), 'assets', 'assets_遊俠精靈'))
SRC_CHAR = os.path.join(ASSET_DIR, 'elf-woman-idle-walk-run.glb')
SRC_FLUTE = os.path.join(ASSET_DIR, 'Meshy_AI_elven_magical_flute_20261112_image-to-3d-texture.glb')
OUT_GLB = os.path.join(REPO, 'public', 'models', 'ranger')
OUT_BLEND = os.path.join(REPO, 'tools', 'blender', 'out')
PREVIEW_DIR = os.environ.get('RANGER_PREVIEW_DIR', os.path.join(OUT_BLEND, 'ranger_preview'))

# build_violinist 的共用函式讀取它自己的模組常數：改成這個角色的值
bv.OUT_GLB, bv.OUT_BLEND = OUT_GLB, OUT_BLEND
# 臉（接地後的座標）：眼睛 z≈1.558、臉正面 y≈-0.09、頭中心 y≈+0.02
bv.FACE_CENTER = Vector((0.0, 0.02, 1.553))
bv.FACE_RADII = Vector((0.085, 0.125, 0.115))
bv.FACE_EXTENT = (0.074, 0.092)

TEX_SIZE = 2048
LOD1_RATIO = 0.3
FPS = 24
SINK = 0.004
# 順序有關：先把原本的 Spine 改掉，Spine02 才能改名為 Spine
RENAME = (('Spine', 'Spine2'), ('Spine01', 'Spine1'), ('Spine02', 'Spine'), ('neck', 'Neck'))
# 長笛：全長、握點（右手，由吹口端算起）、吹口（嘴唇貼的位置）、左手握點；皆為沿笛身的距離
FLUTE_LEN = 0.60
FLUTE_TRIS = 18000
FLUTE_GRIP = 0.37
FLUTE_LIP = 0.075
FLUTE_LEFT = 0.215
FLUTE_R = 0.0142
# 手（rest，T-pose、掌心朝下）：手腕到指根 / 指節的距離；握住時笛身中心相對手腕的位置（沿手指方向 / 掌心方向）
KNUCKLE, PIP, TIP = 0.090, 0.127, 0.169
GRIP_ALONG, GRIP_OUT = 0.064, 0.027
LIPS = Vector((0.0, -0.086, 1.500))
# 程序化步態：timeScale=1 時腳底相對地面的速度（m/s）；遊戲端 RANGER_ANIM.gaitRef 要一致
WALK_FRAMES, WALK_REF = 16, 1.6
RUN_FRAMES, RUN_REF = 10, 6.5

X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
Sn, Cs, TAU = math.sin, math.cos, 2 * math.pi
FWD = Vector((0, -1, 0))  # 角色面向 Blender -Y（glTF +Z）
smooth, lerp, vlerp = bv.smooth, bv.lerp, bv.vlerp


def log(*a):
    print('[ranger]', *a)


# ───────────────────────── 1. 載入 / 正規化 ─────────────────────────
def load_char():
    bpy.ops.import_scene.gltf(filepath=SRC_CHAR)
    for o in list(bpy.data.objects):
        if o.type == 'MESH' and o.parent is None:
            bpy.data.objects.remove(o, do_unlink=True)  # Meshy 附帶的 Icosphere
    rig = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    me = next(o for o in bpy.data.objects if o.type == 'MESH')
    rig.name, rig.data.name = 'RangerRig', 'RangerRig'
    me.name = me.data.name = 'RangerMesh_LOD0'
    sc = bpy.context.scene
    sc.render.fps, sc.render.fps_base = FPS, 1.0
    # Meshy 的 Idle / Walk / Run 不使用（跑步是張開雙手的衝刺，而且她手上要拿長笛）：動作全部由 build_actions 產生
    if rig.animation_data:
        rig.animation_data.action = None
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    bpy.ops.object.select_all(action='DESELECT')
    for o in (rig, me):
        o.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # 沒有權重的輔助骨（頭頂 / 臉前方的標記）
    bpy.ops.object.mode_set(mode='EDIT')
    for n in ('head_end', 'headfront'):
        if n in rig.data.edit_bones:
            rig.data.edit_bones.remove(rig.data.edit_bones[n])
    bpy.ops.object.mode_set(mode='OBJECT')
    for n in ('head_end', 'headfront'):
        if n in me.vertex_groups:
            me.vertex_groups.remove(me.vertex_groups[n])
    for old, new in RENAME:
        rig.data.bones[old].name = new
    co = np.array([v.co[:] for v in me.data.vertices])
    log('mesh bbox', co.min(0).round(3), co.max(0).round(3), 'bones', len(rig.data.bones))
    return rig, me


def skin_vertices(me):
    """膚色頂點：這個角色的皮膚很白（約 0.82, 0.80, 0.76），頭髮是偏冷的銀色、髮尾淡綠，上衣是橄欖綠"""
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
    return (c[:, 0] > 0.55) & (c[:, 0] >= c[:, 1] - 0.005) & (c[:, 1] >= c[:, 2] - 0.01) & (c[:, 0] - c[:, 2] > 0.02)


bv.skin_vertices = skin_vertices


def add_finger_bones(rig, me):
    """每隻手兩節四指骨（Fingers1：指根、Fingers2：指節）。拇指（在手掌前緣、朝前）維持跟著手骨"""
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    eb = rig.data.edit_bones
    info = {}
    for S, s in (('Left', 1), ('Right', -1)):
        h = eb[f'{S}Hand']
        w = h.head.copy()
        # 手骨改成沿手軸（Meshy 的手骨尾端歪向前上方），roll 一律掌心朝下
        h.tail = w + Vector((s * KNUCKLE, 0, 0))
        h.align_roll(Vector((0, 0, 1)))
        prev = h
        for i, (a, b) in enumerate(((KNUCKLE, PIP), (PIP, TIP))):
            fb = eb.new(f'{S}Fingers{i + 1}')
            fb.head = w + Vector((s * a, 0.004, 0.004))
            fb.tail = w + Vector((s * b, 0.004, 0.004))
            fb.align_roll(Vector((0, 0, 1)))
            fb.parent = prev
            fb.use_connect = False
            fb.use_deform = True
            prev = fb
        info[S] = w
    bpy.ops.object.mode_set(mode='OBJECT')
    co, _ = bv.mesh_co_edges(me)
    names, W = bv.read_weights(me)
    gi = {k: i for i, k in enumerate(names)}
    moved = 0
    for S, s in (('Left', 1), ('Right', -1)):
        w0 = info[S]
        hg = me.vertex_groups[f'{S}Hand']
        f1 = me.vertex_groups.new(name=f'{S}Fingers1')
        f2 = me.vertex_groups.new(name=f'{S}Fingers2')
        along = (co[:, 0] - w0.x) * s
        wh = W[:, gi[f'{S}Hand']]
        # 拇指：y 比四指更前面（四指最前緣約 y = -0.013）
        sel = (wh > 0.01) & (along > KNUCKLE - 0.014) & (co[:, 1] > -0.017)
        k1 = bv.smoothstep_np(KNUCKLE - 0.012, KNUCKLE + 0.012, along)
        k2 = bv.smoothstep_np(PIP - 0.010, PIP + 0.010, along)
        for i in np.nonzero(sel)[0]:
            i = int(i)
            t = float(wh[i])
            a, b = float(k1[i]), float(k2[i])
            hg.add([i], t * (1 - a), 'REPLACE')
            if a - b > 1e-4:
                f1.add([i], t * (a - b), 'REPLACE')
            if b > 1e-4:
                f2.add([i], t * b, 'REPLACE')
            moved += 1
    bv.limit_influences(me)
    log('finger bones: re-skinned', moved, 'verts')


# ───────────────────────── 2. 長笛 ─────────────────────────
def add_prop_bone(rig):
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    eb = rig.data.edit_bones
    h = eb['RightHand']
    b = eb.new('prop_flute')
    # rest：握點在掌心下方、笛身沿角色前後（吹口朝前）；實際位置每個動作各自打關鍵影格
    b.head = h.head + Vector((-GRIP_ALONG, 0, -GRIP_OUT))
    b.tail = b.head + Vector((0, 0.1, 0))
    b.align_roll(Vector((0, 0, 1)))
    b.parent = h
    b.use_deform = False
    bpy.ops.object.mode_set(mode='OBJECT')


def load_flute():
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=SRC_FLUTE)
    obs = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    ob = obs[0]
    for o in [o for o in bpy.data.objects if o not in before and o is not ob]:
        bpy.data.objects.remove(o, do_unlink=True)
    ob.name = ob.data.name = 'Flute'
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    ob.parent = None
    dec = ob.modifiers.new('Dec', 'DECIMATE')
    dec.ratio = min(1.0, FLUTE_TRIS / max(1, bv.tri_count(ob)))
    dec.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier='Dec')
    me = ob.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    # 來源：笛身沿 X，吹口在 -X、喇叭口在 +X，音孔朝 +Z
    s = FLUTE_LEN / (co[:, 0].max() - co[:, 0].min())
    co *= s
    x0 = co[:, 0].min()
    mid = co[np.abs(co[:, 0] - (x0 + FLUTE_LEN * 0.5)) < 0.03]
    cy, cz = np.median(mid[:, 1]), np.median(mid[:, 2])
    # 道具骨區域座標：原點＝右手握點，+Y 指向喇叭口（箭矢 / 繩索從這一端出去），+Z＝音孔那一面
    out = np.stack([-(co[:, 1] - cy), co[:, 0] - x0 - FLUTE_GRIP, co[:, 2] - cz], axis=1)
    me.vertices.foreach_set('co', out.reshape(-1))
    me.update()
    for p in me.polygons:
        p.use_smooth = True
    mat = me.materials[0]
    mat.name = 'M_Flute'
    for n in list(mat.node_tree.nodes):
        if n.type == 'TEX_IMAGE' and n.image:
            img = n.image
            if any(l.to_node.type == 'NORMAL_MAP' for l in n.outputs[0].links):
                mat.node_tree.nodes.remove(n)  # 法線貼圖：遊戲距離看不出來，移除以節省容量
                continue
            img.name = 'flute_' + ('orm' if img.colorspace_settings.is_data else 'color')
            target = 1024 if not img.colorspace_settings.is_data else 512
            if img.size[0] > target:
                img.scale(target, target)
    for n in list(mat.node_tree.nodes):
        if n.type == 'NORMAL_MAP':
            mat.node_tree.nodes.remove(n)
    log('flute tris', bv.tri_count(ob), 'tip (bell) local y', round(FLUTE_LEN - FLUTE_GRIP, 3), 'mouth end local y', -FLUTE_GRIP)
    return ob


# ───────────────────────── 3. 動作 ─────────────────────────
def build_actions(rig, me, fidx):
    bones = rig.data.bones
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    keyed = [b.name for b in bones]
    head0 = {b.name: b.head_local.copy() for b in bones}
    rest3 = {b.name: b.matrix_local.to_3x3() for b in bones}
    restM = {b.name: b.matrix_local.copy() for b in bones}
    L = {S: dict(up=(head0[f'{S}ForeArm'] - head0[f'{S}Arm']).length, lo=(head0[f'{S}Hand'] - head0[f'{S}ForeArm']).length) for S in ('Left', 'Right')}
    LL = {S: dict(up=(head0[f'{S}Leg'] - head0[f'{S}UpLeg']).length, lo=(head0[f'{S}Foot'] - head0[f'{S}Leg']).length) for S in ('Left', 'Right')}
    SH = {S: head0[f'{S}Arm'] for S in ('Left', 'Right')}
    SGN = {'Left': 1, 'Right': -1}
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix()
    bpy.context.view_layer.update()
    lift0 = float(bv.eval_coords(me, fidx)[:, 2].min())
    ANK = {S: head0[f'{S}Foot'] - Vector((0, 0, lift0)) for S in ('Left', 'Right')}
    log(f'rest feet lift {lift0:.3f}, arm {L["Left"]}, leg {LL["Left"]}, hips {head0["Hips"].z:.3f}, ankle {tuple(round(v, 3) for v in ANK["Left"])}')

    def upd():
        bpy.context.view_layer.update()

    def R(bname, *rots):
        Bm = rest3[bname].inverted()
        q = Quaternion()
        for ax, deg in rots:
            q = Quaternion(Bm @ ax, math.radians(deg)) @ q
        return q

    def rot(P, bname, *rots):
        P[bname].rotation_quaternion = R(bname, *rots)

    CHILD = {'LeftArm': 'LeftForeArm', 'LeftForeArm': 'LeftHand', 'RightArm': 'RightForeArm', 'RightForeArm': 'RightHand',
             'LeftUpLeg': 'LeftLeg', 'LeftLeg': 'LeftFoot', 'RightUpLeg': 'RightLeg', 'RightLeg': 'RightFoot'}

    def aim(P, name, target):
        """旋轉骨頭，讓「骨頭頭 → 子骨頭頭」指向目標點（最小旋轉保留扭轉）"""
        upd()
        pb = P[name]
        head = pb.head.copy()
        cur = P[CHILD[name]].head - head
        r = cur.normalized().rotation_difference((Vector(target) - head).normalized()).to_matrix()
        pb.matrix = Matrix.Translation(head) @ (r @ pb.matrix.to_3x3()).to_4x4()
        upd()

    def ik(P, up, lo, a, b, target, pole):
        upd()
        S = P[up].head.copy()
        d = Vector(target) - S
        dist = max(1e-4, min(d.length, (a + b) * 0.999))
        dn = d.normalized()
        ca = max(-1.0, min(1.0, (a * a + dist * dist - b * b) / (2 * a * dist)))
        pl = Vector(pole)
        pl = (pl - dn * pl.dot(dn)).normalized()
        elbow = S + dn * a * ca + pl * a * math.sqrt(1 - ca * ca)
        aim(P, up, elbow)
        aim(P, lo, S + dn * dist)

    def set_world_rot(P, name, D):
        """把骨頭的世界方向設成「rest 方向再轉 D」（D：3x3 世界旋轉）"""
        upd()
        pb = P[name]
        pb.matrix = Matrix.Translation(pb.head.copy()) @ (D @ rest3[name]).to_4x4()
        upd()

    def hand_frame(S, d, n):
        """手的世界旋轉（相對 rest）：手指方向 d、掌心方向 n。rest：手指 ±X、掌心 -Z"""
        d = Vector(d).normalized()
        n = Vector(n)
        n = (n - d * n.dot(d)).normalized()
        t = d.cross(n)
        d0, n0 = Vector((SGN[S], 0, 0)), Vector((0, 0, -1))
        t0 = d0.cross(n0)
        A = Matrix((d, n, t)).transposed()
        B = Matrix((d0, n0, t0)).transposed()
        return A @ B.inverted()

    def hand(P, S, wrist, D, pole, curl=(20, 20), twist=0.6):
        """手腕放到 wrist、手的方向為 D（hand_frame）；前臂分擔一部分扭轉；四指彎曲 curl（度）"""
        ik(P, f'{S}Arm', f'{S}ForeArm', L[S]['up'], L[S]['lo'], wrist, pole)
        fa = P[f'{S}ForeArm']
        # 前臂的扭轉：手相對前臂繞前臂軸的扭轉量，分 twist 的比例給前臂（手腕才不會像擰毛巾）
        upd()
        Df = fa.matrix.to_3x3() @ rest3[f'{S}ForeArm'].inverted()
        q = (D @ Df.inverted()).to_quaternion()
        axis = (P[f'{S}Hand'].head - fa.head).normalized()
        proj = Vector((q.x, q.y, q.z)).dot(axis)
        ang = 2 * math.atan2(proj, q.w)
        if ang > math.pi:
            ang -= TAU
        if ang < -math.pi:
            ang += TAU
        if abs(ang) > 1e-4:
            r = Quaternion(axis, ang * twist).to_matrix()
            fa.matrix = Matrix.Translation(fa.head.copy()) @ (r @ fa.matrix.to_3x3()).to_4x4()
        set_world_rot(P, f'{S}Hand', D)
        # 四指繞「指根軸」往掌心彎
        d = D @ Vector((SGN[S], 0, 0))
        n = D @ Vector((0, 0, -1))
        ax = d.cross(n)
        tot = 0.0
        for i, deg in enumerate(curl):
            tot += deg
            set_world_rot(P, f'{S}Fingers{i + 1}', Quaternion(ax, math.radians(tot)).to_matrix() @ D)

    def mix_frames(A, B, k):
        return A.to_quaternion().slerp(B.to_quaternion(), k).to_matrix()

    def leg(P, S, ankle, pole=None, pitch=0.0, yaw=0.0):
        s = SGN[S]
        ik(P, f'{S}UpLeg', f'{S}Leg', LL[S]['up'], LL[S]['lo'], ankle, pole or (0.06 * s, -1, 0.05))
        # 腳掌：rest 的世界方向再加 pitch（> 0 腳尖下壓）與 yaw（> 0 腳尖朝外）
        D = Matrix.Rotation(math.radians(yaw * s), 3, 'Z') @ Matrix.Rotation(math.radians(pitch), 3, 'X')
        set_world_rot(P, f'{S}Foot', D)

    def hips(P, off=(0, 0, 0), *rots):
        P['Hips'].rotation_quaternion = R('Hips', *rots)
        upd()
        pb = P['Hips']
        M = pb.matrix.copy()
        M.translation = head0['Hips'] + Vector(off)
        pb.matrix = M
        upd()

    def stand(P, off=(0, 0, 0), rots=(), feet=None, yaw=8.0, knee=0.0):
        """站姿：骨盆位移 / 旋轉，雙腳 IK 釘在地上。預設站得比 T-pose 窄、腳尖微微朝外"""
        hips(P, Vector(off) + Vector((0, 0, -0.012)), *rots)
        feet = feet or {}
        for S, s in (('Left', 1), ('Right', -1)):
            f = feet.get(S, (0, 0, 0, 0))
            tgt = Vector((s * 0.082 + f[0], ANK[S].y + f[1], ANK[S].z + f[2] - SINK))
            leg(P, S, tgt, (0.10 * s + knee * s, -1, 0.05), pitch=f[3], yaw=yaw)

    # ── 長笛與手 ──
    # 右手與長笛的關係固定：長笛區域座標中的手指方向 / 掌心方向（吹奏時：手在笛身後方、掌心朝前下、四指由上方越過笛身）
    RH_D = Vector((-0.5, 0, 0.866))
    RH_N = Vector((-0.866, 0, -0.5))
    # 左手（吹奏時才握上去）：手在笛身前方、掌心朝向自己、四指由上方往回勾
    LH_D = Vector((0.42, 0, 0.907))
    LH_N = Vector((0.907, 0, -0.42))

    def flute_matrix(origin, ydir, zdir):
        y = Vector(ydir).normalized()
        z = Vector(zdir)
        z = (z - y * z.dot(y)).normalized()
        x = y.cross(z)
        M = Matrix((x, y, z)).transposed().to_4x4()
        M.translation = Vector(origin)
        return M

    def mix_flute(A, B, k):
        """長笛在兩個位置之間移動：途中往前繞出去（直線內插會穿過胸口）"""
        M = A.to_quaternion().slerp(B.to_quaternion(), k).to_matrix().to_4x4()
        M.translation = A.translation.lerp(B.translation, k) + Vector((-0.03, -0.11, 0.0)) * Sn(math.pi * k)
        return M

    def right_on(P, F, pole, curl=(78, 82)):
        """右手握住長笛 F（世界矩陣）"""
        R3 = F.to_3x3()
        d, n = R3 @ RH_D, R3 @ RH_N
        wrist = F.translation - d * GRIP_ALONG - n * GRIP_OUT
        hand(P, 'Right', wrist, hand_frame('Right', d, n), pole, curl)

    def left_target(F):
        R3 = F.to_3x3()
        d, n = R3 @ LH_D, R3 @ LH_N
        g = F.translation + R3 @ Vector((0, FLUTE_LEFT - FLUTE_GRIP, 0))
        return g - d * GRIP_ALONG - n * GRIP_OUT, hand_frame('Left', d, n)

    def set_flute(P, F):
        upd()
        P['prop_flute'].matrix = F
        upd()

    def carry_flute(P, swing=0.0, out=0.0, back=0.0, raise_=0.0, wrist=None, d=None):
        """持笛的右手：掌心朝大腿、吹口那一端在拇指側朝前（舉到嘴邊時只要把手抬起來）。
        預設自然垂在身側；wrist / d 指定手腕位置與手指方向（步態的擺臂）"""
        upd()
        if wrist is None:
            sh = P['RightArm'].head.copy()
            wrist = sh + Vector((-0.058 - out, -0.03 + back - 0.05 * swing, -0.358 + raise_ + 0.012 * abs(swing)))
        if d is None:
            d = Vector((-0.06, 0.36 + 0.10 * swing, -0.93))
        d = Vector(d).normalized()
        n = Vector((1, 0.05, 0))
        n = (n - d * n.dot(d)).normalized()
        a = n.cross(d)  # 喇叭口方向；右手的拇指（d × n）朝吹口 = -a
        # 由手推回長笛：F 的旋轉把 (RH_D, RH_N, +Y) 轉到 (d, n, a)
        A = Matrix((d, n, a)).transposed()
        B = Matrix((RH_D, RH_N, Vector((0, 1, 0)))).transposed()
        F = (A @ B.inverted()).to_4x4()
        F.translation = wrist + d * GRIP_ALONG + n * GRIP_OUT
        return F

    def left_rest(P, b=0.0):
        """沒拿東西的左手：自然垂下、手指微彎"""
        upd()
        sh = P['LeftArm'].head.copy()
        wrist = sh + Vector((0.062, -0.03, -0.357 + 0.004 * b))
        return wrist, hand_frame('Left', (0.08, -0.12, -1), (-1, 0.1, 0))

    def lips(P):
        upd()
        M = P['Head'].matrix @ restM['Head'].inverted()
        return M @ LIPS, M.to_3x3()

    def play_flute(P, tilt=0.0, yaw=0.0, drop=0.0):
        """橫笛吹奏：吹口貼在下唇、笛身往右伸出去、喇叭口略低；tilt：喇叭口再往下壓（度），yaw：笛身往前轉（度）"""
        lp, H = lips(P)
        a = Vector((-Cs(math.radians(10 + tilt)) * Cs(math.radians(12 + yaw)), -Sn(math.radians(12 + yaw)), -Sn(math.radians(10 + tilt))))
        a = (H @ a).normalized()
        e = lp + H @ Vector((0, -FLUTE_R - 0.004, -0.010 - drop))
        return flute_matrix(e + a * (FLUTE_GRIP - FLUTE_LIP), a, H @ Vector((0, -0.5, 1)))

    POLE_R_CARRY, POLE_L_REST = (-0.25, 1, 0), (0.25, 1, 0)
    POLE_R_PLAY, POLE_L_PLAY = (-0.55, 0.25, -1), (0.75, 0.0, -1)

    def both_hands(P, Fc, Fp, k, kl=None):
        """k：長笛由持笛位置 Fc 舉到吹奏位置 Fp 的進度；kl：左手握上去的進度（預設同 k）"""
        kl = k if kl is None else kl
        F = mix_flute(Fc, Fp, k)
        right_on(P, F, vlerp(POLE_R_CARRY, POLE_R_PLAY, k))
        wr, Dr = left_rest(P)
        wt, Dt = left_target(F)
        # 左手先抬到笛子前方再握上去：途中往前繞，避免穿過胸口
        w = wr.lerp(wt, kl) + Vector((0.03, -0.09, 0.03)) * math.sin(math.pi * kl)
        hand(P, 'Left', w, mix_frames(Dr, Dt, kl), vlerp(POLE_L_REST, POLE_L_PLAY, kl), (lerp(22, 76, kl), lerp(25, 80, kl)))
        set_flute(P, F)
        return F

    def reset_pose():
        for pb in rig.pose.bones:
            pb.matrix_basis = Matrix()
        upd()

    def make(name, length, fn, step, loop=True):
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        rig.animation_data_create()
        rig.animation_data.action = act
        for f in range(0, length + 1, step):
            reset_pose()
            P = rig.pose.bones
            fn(f / length, P)
            for n in keyed:
                P[n].keyframe_insert('rotation_quaternion', frame=f)
            for n in ('Hips', 'prop_flute'):
                P[n].keyframe_insert('location', frame=f)
        # 相鄰影格的四元數取同一半球（否則內插會繞遠路，手腕 / 長笛在兩格之間甩一圈）
        for fc_group in quat_groups(act):
            prev = None
            n = len(fc_group[0].keyframe_points)
            for i in range(n):
                q = [fc.keyframe_points[i].co[1] for fc in fc_group]
                if prev is not None and sum(a * b for a, b in zip(q, prev)) < 0:
                    for fc in fc_group:
                        fc.keyframe_points[i].co[1] *= -1
                    q = [-v for v in q]
                prev = q
            for fc in fc_group:
                fc.update()
        if loop:
            for fc in bv.channel_fcurves(act):
                if not any(md.type == 'CYCLES' for md in fc.modifiers):
                    fc.modifiers.new('CYCLES')
                fc.update()
        return act

    def quat_groups(act):
        groups = {}
        for fc in bv.channel_fcurves(act):
            if fc.data_path.endswith('rotation_quaternion'):
                groups.setdefault(fc.data_path, [None] * 4)[fc.array_index] = fc
        return [g for g in groups.values() if all(g)]

    # ── 步態 ──
    FOOT = 0.105  # 腳踝到前腳掌著地點的水平距離

    def gait(frames, speed, stance, lift, lean, twist, shift, narrow, arms, flight=0.0, dip=0.012, push=18.0, kick=30.0, land=0.0, bob=1.0, drive=0.6):
        """IK 步態：支撐腳鎖在地面、以 speed（m/s，timeScale=1 時）往後移動 → 遊戲依實際速度調整播放速率就不滑步。
        支撐期後段腳跟先離地（push 度），擺動期小腿往後收（kick 度、lift 公尺）再往前帶；擺動腳的前後位置用 Hermite 曲線，
        離地與落地瞬間的速度和地面一致。骨盆高度＝支撐腳碰得到地面的最高位置，bob 壓小上下起伏"""
        cyc = frames / FPS
        D = speed * stance * cyc
        hip0 = {S: head0[f'{S}UpLeg'] for S in ('Left', 'Right')}
        h0 = FOOT * Sn(math.radians(push))

        def foot(S, t):
            p = (t + (0.0 if S == 'Left' else 0.5)) % 1.0
            a = ANK[S]
            if p < stance:
                u = p / stance
                pit = push * smooth((u - 0.55) / 0.45) - land * (1 - smooth(u / 0.2))
                fwd, h, q = D / 2 - u * D, FOOT * Sn(math.radians(max(pit, 0.0))), None
            else:
                q = (p - stance) / (1 - stance)
                m = -D * (1 - stance) / stance * drive
                h00, h10, h01, h11 = 2 * q ** 3 - 3 * q ** 2 + 1, q ** 3 - 2 * q ** 2 + q, -2 * q ** 3 + 3 * q ** 2, q ** 3 - q ** 2
                fwd = h00 * (-D / 2) + h10 * m + h01 * (D / 2) + h11 * m
                h = h0 * (1 - smooth(q / 0.4)) + lift * Sn(math.pi * q ** 0.8) ** 1.1
                pit = lerp(push, kick, smooth(q / 0.3)) if q < 0.3 else lerp(kick, -land, smooth((q - 0.3) / 0.7))
            return Vector((a.x * narrow, a.y - fwd, a.z + h)), q, pit

        N = 64
        dz = []
        for i in range(N):
            lim = []
            for S in ('Left', 'Right'):
                tgt, q, _ = foot(S, i / N)
                if q is None:
                    hp = hip0[S]
                    hd = math.hypot(tgt.x - hp.x, tgt.y - hp.y)
                    reach = (LL[S]['up'] + LL[S]['lo']) * 0.985
                    lim.append(tgt.z + math.sqrt(max(reach * reach - hd * hd, 0.0)) - hp.z)
            dz.append(min(lim) - dip if lim else None)
        for i in range(N):
            if dz[i] is None:
                j0 = next(k for k in range(1, N) if dz[(i - k) % N] is not None)
                j1 = next(k for k in range(1, N) if dz[(i + k) % N] is not None)
                a0, a1 = dz[(i - j0) % N], dz[(i + j1) % N]
                u = j0 / (j0 + j1)
                dz[i] = a0 + (a1 - a0) * u + flight * Sn(math.pi * u)
        zmax = max(dz)
        dz = [zmax - (zmax - v) * bob for v in dz]
        # 平滑一次（支撐 / 騰空交界的折角）
        for _ in range(2):
            dz = [(dz[(i - 1) % N] + 2 * dz[i] + dz[(i + 1) % N]) / 4 for i in range(N)]

        def f(t, P):
            c = Cs(t * TAU)
            ph = Cs((t - stance / 2) * TAU)  # +1：左腳支撐中段、-1：右腳支撐中段
            x = t * N
            i0 = int(x) % N
            z = dz[i0] + (dz[(i0 + 1) % N] - dz[i0]) * (x - int(x))
            # 骨盆：落地那一側的髖往前（左腳在 t=0 落在前方）、重心移向支撐腳；軀幹反向扭回來，頭保持朝前
            hips(P, (shift * ph, -0.004 * lean, z - SINK), (Z, -twist * c), (Y, -1.5 * ph), (X, lean * 0.4))
            rot(P, 'Spine', (Z, twist * 0.55 * c), (X, lean * 0.3))
            rot(P, 'Spine1', (Z, twist * 0.5 * c), (Y, 1.2 * ph), (X, lean * 0.2))
            rot(P, 'Spine2', (Z, twist * 0.45 * c), (X, lean * 0.1))
            rot(P, 'Neck', (X, -lean * 0.3))
            rot(P, 'Head', (Z, -twist * 0.3 * c), (X, -lean * 0.45))
            for S in ('Left', 'Right'):
                tgt, q, pit = foot(S, t)
                tgt.z -= SINK
                leg(P, S, tgt, (0.05 * SGN[S], -1, 0.1), pitch=pit, yaw=3.0)
            arms(t, P, c)
        return f

    def gait_arms(swing, bend, bias, swing_r, bend_r):
        """擺臂：上臂前後擺 ±swing 度（bias：整體往後收）、手肘彎 bend 度。左手空手自然擺；
        右手持笛（swing_r / bend_r 較小），笛身跟著前臂。c = cos：t=0 左腳在前 → 右手在前"""
        def swing_arm(P, S, th, be, xo):
            sh = P[f'{S}Arm'].head.copy()
            th, be = math.radians(th), math.radians(be)
            up, lo = L[S]['up'], L[S]['lo']
            fd = Vector((-0.10 * SGN[S] * Sn(be), -Sn(th + be), -Cs(th + be))).normalized()  # 前臂方向（彎起來時手往中線收）
            wrist = sh + Vector((xo * SGN[S], -Sn(th) * up, -Cs(th) * up)) + fd * lo
            return wrist, fd

        def f(t, P, c):
            upd()
            k = -c  # 左手往前的程度
            w, fd = swing_arm(P, 'Left', bias + swing * k, bend + 8 * k, 0.045)
            hand(P, 'Left', w, hand_frame('Left', fd, (-1, 0.15, 0)), (0.3, 1, 0.2), (48, 58))
            w, fd = swing_arm(P, 'Right', bias + swing_r * c, bend_r + 4 * c, 0.05)
            F = carry_flute(P, wrist=w, d=fd)
            right_on(P, F, (-0.3, 1, 0.2))
            set_flute(P, F)
        return f

    # ── 各動作 ──
    def idle(t, P):
        b = Sn(t * TAU)
        b2 = Sn(t * TAU * 2 + 0.6)
        # 重心略放在右腳、左腳微微踏前（不是立正）
        stand(P, (-0.012 + 0.003 * b, 0.004, -0.004 + 0.002 * b2), ((Y, 2.0 + 0.6 * b), (Z, -3 + 1.2 * b)),
              feet={'Left': (0.005, -0.03, 0, 0), 'Right': (0, 0.012, 0, 0)}, knee=0.03)
        rot(P, 'Spine', (Y, -1.2), (X, -0.8 + 0.5 * b2))
        rot(P, 'Spine1', (Y, -1.0 - 0.4 * b), (X, 0.9 * b2))
        rot(P, 'Spine2', (Z, 2.0), (X, 0.6 * b2))
        rot(P, 'Neck', (Z, 2 * b), (X, 1.0))
        rot(P, 'Head', (Y, 2.5 * Sn(t * TAU + 1)), (Z, 3 + 3 * b), (X, 2.0))
        F = carry_flute(P, swing=0.04 * b, raise_=0.003 * b2)
        right_on(P, F, POLE_R_CARRY)
        set_flute(P, F)
        w, D = left_rest(P, b)
        hand(P, 'Left', w, D, POLE_L_REST, (24 + 3 * b, 28))

    def play_body(P, sway, lean=0.0, twist=0.0):
        rot(P, 'Spine', (Y, -1.5 * sway), (X, lean * 0.35), (Z, twist * 0.3))
        rot(P, 'Spine1', (Y, -1.5 * sway), (X, lean * 0.35), (Z, twist * 0.3))
        rot(P, 'Spine2', (Z, -6 + twist * 0.4), (X, lean * 0.3))
        # 頭往左轉一點、微微側傾，像真的在吹橫笛
        rot(P, 'Neck', (Z, 5), (Y, 2))
        rot(P, 'Head', (Z, 9 + 1.5 * sway), (Y, 5 + 1.5 * sway), (X, 3))

    def play(t, P):
        sway = Sn(t * TAU)
        br = Sn(t * TAU * 2)
        stand(P, (0.008 * sway, 0, -0.003 + 0.002 * br), ((Y, 2.2 * sway), (Z, 2.5 * sway)), feet={'Left': (0, -0.02, 0, 0)})
        play_body(P, sway, lean=-1.5 + 1.0 * br)
        Fp = play_flute(P, tilt=2.5 * sway)
        both_hands(P, Fp, Fp, 1.0)
        # 手指按孔的小動作
        for S, ph in (('Left', 0.0), ('Right', 1.7)):
            upd()
            pb = P[f'{S}Fingers2']
            Dh = P[f'{S}Hand'].matrix.to_3x3() @ rest3[f'{S}Hand'].inverted()
            axis = (Dh @ Vector((SGN[S], 0, 0))).cross(Dh @ Vector((0, 0, -1)))
            r = Quaternion(axis, math.radians(7 * Sn(t * TAU * 4 + ph))).to_matrix()
            pb.matrix = Matrix.Translation(pb.head.copy()) @ (r @ pb.matrix.to_3x3()).to_4x4()
            upd()

    def shoot(t, P):
        # 0.83 s：0～0.21 s 舉笛到唇邊並微微後仰吸氣 → 0.33 s 急促的一聲（上身往前一頓，箭在此刻出現）→ 0.5 s 起放下
        T = t * 20 / FPS
        up = smooth(T / 0.22)
        down = smooth((T - 0.52) / 0.31)
        k = up * (1 - down)
        acc = math.exp(-((T - 0.34) / 0.07) ** 2)  # 吹出那一聲
        pre = math.exp(-((T - 0.20) / 0.09) ** 2)
        lean = -4 * pre + 9 * acc
        stand(P, (0, -0.012 * acc + 0.008 * pre, -0.008 * k - 0.012 * acc), ((X, lean * 0.3), (Z, -4 * k)),
              feet={'Left': (0, -0.03 - 0.05 * k, 0, 0), 'Right': (0, 0.012 + 0.03 * k, 0, 0)})
        play_body(P, 0, lean=lean, twist=-6 * k)
        rot(P, 'Head', (Z, 9 * k), (Y, 5 * k), (X, 3 * k - 4 * acc))
        rot(P, 'Neck', (Z, 5 * k), (Y, 2 * k))
        rot(P, 'Spine2', (Z, (-6 - 2.4) * k), (X, lean * 0.3))
        Fc = carry_flute(P)
        Fp = play_flute(P, tilt=-3 * acc, yaw=4 * acc)
        both_hands(P, Fc, Fp, k, smooth((T - 0.03) / 0.2) * (1 - smooth((T - 0.5) / 0.28)))

    def plant(t, P):
        # 0.58 s：邊吹低音邊屈膝前傾，喇叭口往腳前的地面一點（0.33 s 藤蔓冒出來），再起身放下
        T = t * 14 / FPS
        up = smooth(T / 0.2)
        down = smooth((T - 0.40) / 0.18)
        k = up * (1 - down)
        dipk = math.exp(-((T - 0.32) / 0.09) ** 2)
        stand(P, (0, -0.02 * dipk, -0.03 * k - 0.05 * dipk), ((X, 5 * k + 6 * dipk),),
              feet={'Left': (0, -0.05 * k, 0, 0), 'Right': (0, 0.03 * k, 0, 0)}, knee=0.05)
        play_body(P, 0, lean=7 * k + 12 * dipk)
        rot(P, 'Head', (Z, 9 * k), (Y, 5 * k), (X, 3 * k + 6 * dipk))
        rot(P, 'Neck', (Z, 5 * k), (Y, 2 * k), (X, 4 * dipk))
        rot(P, 'Spine2', (Z, -6 * k), (X, 2.4 * k + 6 * dipk))
        Fc = carry_flute(P)
        Fp = play_flute(P, tilt=12 * k + 30 * dipk, yaw=12 * dipk)
        both_hands(P, Fc, Fp, k)

    def leap(t, P):
        # 0.5 s（遊戲在 0.38 s 內把角色往後移 6 m）：蹬地 → 收腿後躍、上身前傾看著前方 → 落地屈膝緩衝
        T = t * 12 / FPS
        air = smooth(T / 0.09) * (1 - smooth((T - 0.33) / 0.07))
        u = max(0.0, min(1.0, (T - 0.06) / 0.30))
        hop = 0.34 * 4 * u * (1 - u) if 0 < u < 1 else 0.0
        crouch = 0.10 * math.exp(-((T - 0.05) / 0.035) ** 2) + 0.12 * math.exp(-((T - 0.40) / 0.06) ** 2)
        lean = 16 * air + 8 * math.exp(-((T - 0.40) / 0.07) ** 2)
        hips(P, (0, 0.02 * air, hop - crouch - 0.012), (X, lean * 0.5))
        rot(P, 'Spine', (X, lean * 0.35))
        rot(P, 'Spine1', (X, lean * 0.3))
        rot(P, 'Neck', (X, -lean * 0.3))
        rot(P, 'Head', (X, -lean * 0.5))
        # 空中：前腳（左）往前收、後腳（右）往後上方勾；落地時右腳先踩在後方
        for S, s in (('Left', 1), ('Right', -1)):
            base = Vector((s * 0.082, ANK[S].y, ANK[S].z - SINK))
            if S == 'Left':
                tgt = base + Vector((0, -0.10 * air - 0.04, hop * 0.82 + 0.10 * air))
                pit = 26 * air
            else:
                tgt = base + Vector((0, 0.16 * air + 0.03, hop * 0.9 + 0.20 * air))
                pit = 46 * air
            leg(P, S, tgt, (0.08 * s, -1, 0.1), pitch=pit, yaw=6)
        upd()
        # 右手持笛往側後張開保持平衡、左手往前伸
        F = carry_flute(P, swing=-0.5 * air, out=0.10 * air, back=0.10 * air, raise_=0.10 * air)
        right_on(P, F, (-0.6, 1, 0))
        set_flute(P, F)
        w, D = left_rest(P)
        sh = P['LeftArm'].head.copy()
        w2 = sh + Vector((0.17, -0.20, -0.17))
        D2 = hand_frame('Left', (0.25, -0.8, -0.45), (-0.3, 0.2, -1))
        hand(P, 'Left', w.lerp(w2, air), mix_frames(D, D2, air), (0.8, 0.6, -0.3), (lerp(24, 8, air), lerp(28, 10, air)))

    def capture(t, P):
        # 收網（循環 2 s）：重心放在後腳、上身後仰，吹著笛子把繩索一下一下往回收
        pull = Sn(t * TAU * 2)
        pk = 0.5 + 0.5 * pull
        sway = Sn(t * TAU)
        stand(P, (0.004 * sway, 0.035 + 0.02 * pk, -0.035 - 0.012 * pk), ((X, -5 - 3 * pk), (Z, -6)),
              feet={'Left': (0.01, -0.14, 0, 0), 'Right': (-0.01, 0.10, 0, 0)}, knee=0.02)
        play_body(P, sway * 0.6, lean=-7 - 5 * pk, twist=-8)
        Fp = play_flute(P, tilt=-6 - 4 * pk, yaw=6)
        both_hands(P, Fp, Fp, 1.0)

    def victory(t, P):
        # 勝利（循環 2 s）：右手把長笛高舉過頭輕輕揮動、左手叉腰，身體跟著搖
        b = Sn(t * TAU)
        b2 = Sn(t * TAU * 2)
        stand(P, (0.012 * b, 0, -0.004 + 0.004 * b2), ((Y, 3 * b), (Z, 6 * b)), feet={'Left': (0, -0.03, 0, 0)}, knee=0.02)
        rot(P, 'Spine1', (X, -4), (Y, -2.5 * b))
        rot(P, 'Spine2', (X, -3), (Z, -4 * b))
        rot(P, 'Head', (X, -8), (Z, -5 * b), (Y, 4 * b))
        upd()
        sh = P['RightArm'].head.copy()
        a = Vector((0.25 + 0.22 * b, 0.25, 1)).normalized()  # 喇叭口朝上
        F = flute_matrix(sh + Vector((-0.17 - 0.03 * b, -0.10, 0.36 + 0.015 * b2)), a, (0, -1, 0.2))
        right_on(P, F, (-1, 0.5, -0.2))
        set_flute(P, F)
        sh = P['LeftArm'].head.copy()
        hp = P['Hips'].head.copy()
        hand(P, 'Left', hp + Vector((0.165, -0.035, 0.03)), hand_frame('Left', (-0.25, -0.75, -0.6), (-0.8, 0.5, -0.2)), (0.7, 1, 0.1), (40, 50))

    def stunned(t, P):
        # 暈眩（循環 1.25 s）：站不穩、頭與上身繞圈晃，持笛的手垂下
        a, c = Sn(t * TAU), Cs(t * TAU)
        stand(P, (0.02 * a, 0.012 * c, -0.03), ((Y, 4 * a), (X, 3 * c)), feet={'Left': (0.02, 0, 0, 0), 'Right': (-0.02, 0, 0, 0)}, knee=-0.04)
        rot(P, 'Spine', (Y, -3 * a), (X, 4 + 3 * c))
        rot(P, 'Spine1', (Y, -4 * a), (X, 3 * c))
        rot(P, 'Neck', (Y, 5 * a), (X, 5 * c))
        rot(P, 'Head', (Y, 9 * a), (X, 8 + 7 * c), (Z, 5 * c))
        F = carry_flute(P, swing=0.12 * c, out=0.02)
        right_on(P, F, POLE_R_CARRY)
        set_flute(P, F)
        upd()
        sh = P['LeftArm'].head.copy()
        hand(P, 'Left', sh + Vector((0.14 + 0.02 * a, -0.10, -0.24)), hand_frame('Left', (0.3, -0.4, -1), (-1, 0.2, -0.2)), (0.6, 0.6, -0.2), (12, 15))

    only = [s for s in os.environ.get('RANGER_ONLY_CLIPS', '').split(',') if s]
    clips = [
        ('Idle', 72, idle, 3, True),
        # 走路：小步、兩腳收向中線、上身挺直
        ('Walk', WALK_FRAMES, gait(WALK_FRAMES, WALK_REF, 0.6, 0.045, 2.0, 5, 0.012, 0.5, gait_arms(15, 14, -2, 7, 16), push=20, kick=24, land=7, bob=0.5), 1, True),
        # 奔跑：小步快頻的輕跳步、骨盆維持高度、上身只微微前傾；蹬地後小腿往後收
        ('Run', RUN_FRAMES, gait(RUN_FRAMES, RUN_REF, 0.2, 0.15, 10, 7, 0.006, 0.62, gait_arms(26, 82, -10, 9, 50), flight=0.02, dip=0.012, push=30, kick=62, land=0, bob=0.6, drive=0.32), 1, True),
        ('Play', 48, play, 2, True),
        ('Shoot', 20, shoot, 1, False),
        ('Plant', 14, plant, 1, False),
        ('Leap', 12, leap, 1, False),
        ('Capture', 48, capture, 2, True),
        ('Victory', 48, victory, 2, True),
        ('Stunned', 30, stunned, 2, True),
    ]
    for name, length, fn, step, loop in clips:
        if only and name not in only:
            continue
        make(name, length, fn, step, loop)
        log('clip', name, f'{length / FPS:.3f}s')
    rig.animation_data.action = bpy.data.actions[clips[0][0] if not only else only[0]]
    reset_pose()


# ───────────────────────── 4. 材質 / LOD / 匯出 ─────────────────────────
def prep_material(ob):
    mat = ob.data.materials[0]
    mat.name = 'M_Ranger'
    for n in mat.node_tree.nodes:
        if n.type == 'TEX_IMAGE' and n.image:
            img = n.image
            low = img.name.lower()
            if 'normal' in low:
                img.name = 'ranger_normal'
                bv.save_hires(img, 'ranger_normal_4k.webp')
                target = TEX_SIZE
            elif 'metallic' in low or 'rough' in low:
                img.name = 'ranger_orm'
                target = TEX_SIZE // 2
            else:
                img.name = 'ranger_color'
                bv.save_hires(img, 'ranger_color_4k.webp')
                target = TEX_SIZE
            if img.size[0] > target:
                img.scale(target, target)


def export(rig, objs):
    os.makedirs(OUT_GLB, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for o in [rig] + objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = rig
    path = os.path.join(OUT_GLB, 'ranger.glb')
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True,
        export_animations=True, export_animation_mode='ACTIONS', export_skins=True,
        export_apply=False, export_yup=True, export_texcoords=True, export_normals=True,
        export_image_format='WEBP', export_image_quality=88, export_def_bones=False, export_force_sampling=True,
        export_optimize_animation_size=True, export_meshopt_compression_enable=True,
        export_attributes=True,  # _FACEMASK（臉部遮罩，遊戲 shader 使用）
        export_tangents=True,
    )
    log('exported', path, os.path.getsize(path) // 1024, 'KB')


def preview(rig):
    """每個動作輸出一張預覽圖（workbench）：上排側面、下排斜前方，各 N 格"""
    import subprocess, shutil
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'TEXTURE'
    sc.render.resolution_x = sc.render.resolution_y = int(os.environ.get('RANGER_PREVIEW_RES', '300'))
    sc.render.film_transparent = False
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.data.type = 'ORTHO'
    zoom = os.environ.get('RANGER_PREVIEW_ZOOM')  # "scale,targetZ"
    scale, tz = (float(v) for v in zoom.split(',')) if zoom else (2.0, 0.9)
    cam.data.ortho_scale = scale
    want = [s for s in os.environ.get('RANGER_PREVIEW_CLIPS', '').split(',') if s]
    nfr = int(os.environ.get('RANGER_PREVIEW_N', '6'))
    views = {'s': (-4, 0, tz), 'q': (-2.4, -3.2, tz + 0.35), 'f': (0, -4, tz), 'b': (2.0, 3.4, tz + 0.3)}
    use = os.environ.get('RANGER_PREVIEW_VIEWS', 's,q').split(',')
    magick = shutil.which('magick')
    for act in bpy.data.actions:
        if want and act.name not in want:
            continue
        rig.animation_data.action = act
        f0, f1 = act.frame_range
        loop = any(md.type == 'CYCLES' for fc in bv.channel_fcurves(act) for md in fc.modifiers)
        files = []
        for view in use:
            for i in range(nfr):
                f = f0 + (f1 - f0) * i / (nfr if loop else nfr - 1)
                sc.frame_set(int(f), subframe=f - int(f))
                cam.location = Vector(views[view])
                cam.rotation_euler = (Vector((0, 0, tz)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
                sc.render.filepath = os.path.join(PREVIEW_DIR, f'_{act.name}_{view}_{i}.png')
                bpy.ops.render.render(write_still=True)
                files.append(sc.render.filepath)
        if magick:
            out = os.path.join(PREVIEW_DIR, f'{act.name}.jpg')
            subprocess.run([magick, 'montage', *files, '-tile', f'{nfr}x{len(use)}', '-geometry', '+1+1', '-quality', '88', out], check=True)
            for f in files:
                os.remove(f)
    bpy.data.objects.remove(cam)
    rig.animation_data.action = bpy.data.actions['Idle'] if 'Idle' in bpy.data.actions else None


def main(do_export=True):
    bv.reset()
    rig, me = load_char()
    fast = os.environ.get('RANGER_FAST') == '1'  # 只看動作：略過焊接 / 細分、4K 貼圖、LOD
    if not fast:
        bv.weld_and_smooth(me, None)
        bv.face_normals(me)
    add_finger_bones(rig, me)
    add_prop_bone(rig)
    flute = load_flute()
    bv.attach(flute, rig, 'prop_flute')
    if not fast:
        prep_material(me)
    fidx = bv.foot_verts(me)
    build_actions(rig, me, fidx)
    if fast:
        preview(rig)
        return
    lod1 = bv.make_lod1(me, rig)
    lod1.name = lod1.data.name = 'RangerMesh_LOD1'
    os.makedirs(OUT_BLEND, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_BLEND, 'ranger.blend'))
    if os.environ.get('RANGER_PREVIEW') == '1':
        lod1.hide_render = True
        preview(rig)
        lod1.hide_render = False
    if do_export:
        export(rig, [me, lod1, flute])
    log(f'RANGER_GAIT_REF = {{ Walk: {WALK_REF:.2f}, Run: {RUN_REF:.2f} }}')


if __name__ == '__main__' or __name__ == '<run_path>' or __name__ == 'builtins':
    main(do_export=os.environ.get('RANGER_NO_EXPORT') != '1')
