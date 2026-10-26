"""Retarget Quaternius' Universal Animation Library (CC0 motion capture) onto Kimchi City's 17-bone skeleton.

Run headless:
  ~/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/retarget_ual.py -- UAL1.glb [UAL2.glb ...]

Source: Universal Animation Library 1 and 2 [Standard] by Quaternius, CC0, https://quaternius.com (the in-place
files, without root motion). Writes assets/anims/ual.bin (for every clip, each of our bones' local rotation per
frame at 30 fps and the hips' movement, 16-bit) and ual.json (where each clip is, how long, looping or not), for walk/jog/sprint cycles the ground speed of the stride and the
moment the left foot lands, so the game can match the legs to how fast a character really moves.

How: our bones all have identity rest rotations (the game builds them from joint positions only, facing +x, up +y,
right arm +z), and the actor's rest pose is a T-pose too. Every frame our bone's world rotation is the source
bone's rotation away from its rest; for the arms and legs the source bone is first turned to point exactly the
way ours does in our T-pose (the shortest rotation), so limbs point where the actor's limbs point whatever the
proportions.
"""
import bpy, sys, os, json, math, array
from mathutils import Matrix, Vector, Quaternion

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'assets', 'anims', 'ual.json')
FPS = 30
QS, HS = 32767, 8192      # 16-bit scales: quaternion parts, hips movement (in leg lengths)

BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'armR', 'foreR', 'handR', 'armL', 'foreL', 'handL',
         'legR', 'shinR', 'footR', 'legL', 'shinL', 'footL']
PARENT = {'spine': 'hips', 'chest': 'spine', 'neck': 'chest', 'head': 'neck', 'armR': 'chest', 'foreR': 'armR', 'handR': 'foreR',
          'armL': 'chest', 'foreL': 'armL', 'handL': 'foreL', 'legR': 'hips', 'shinR': 'legR', 'footR': 'shinR',
          'legL': 'hips', 'shinL': 'legL', 'footL': 'shinL'}
# our bone: (source bone, source joint our child joint sits on; None = the end bone keeps its parent's offset)
MAP = {
    'hips': ('pelvis', 'spine_01'), 'spine': ('spine_01', 'spine_03'), 'chest': ('spine_03', 'neck_01'),
    'neck': ('neck_01', 'Head'), 'head': ('Head', None),
    'armR': ('upperarm_r', 'lowerarm_r'), 'foreR': ('lowerarm_r', 'hand_r'), 'handR': ('hand_r', None),
    'armL': ('upperarm_l', 'lowerarm_l'), 'foreL': ('lowerarm_l', 'hand_l'), 'handL': ('hand_l', None),
    'legR': ('thigh_r', 'calf_r'), 'shinR': ('calf_r', 'foot_r'), 'footR': ('foot_r', None),
    'legL': ('thigh_l', 'calf_l'), 'shinL': ('calf_l', 'foot_l'), 'footL': ('foot_l', None),
}
# arms and legs are lined up by direction (absorbs small differences in the two T-poses); the rest copy directly
# (the actor's short pelvis and neck bones lean forward even standing straight, which a direction match would copy)
LIMBS = {'armR', 'foreR', 'armL', 'foreL', 'legR', 'shinR', 'legL', 'shinL'}
# our T-pose: joint positions of the hero (assets/chars3d/kimchi_ai.json), only the directions matter
OUR = json.load(open(os.path.join(ROOT, 'assets', 'chars3d', 'kimchi_ai.json')))['bones']
CHILD = {'hips': 'spine', 'spine': 'chest', 'chest': 'neck', 'neck': 'head', 'armR': 'foreR', 'foreR': 'handR',
         'armL': 'foreL', 'foreL': 'handL', 'legR': 'shinR', 'shinR': 'footR', 'legL': 'shinL', 'shinL': 'footL'}

# the clips the game uses: name in the library -> our name
CLIPS = {
    'Idle_Loop': 'idle', 'Idle_Talking_Loop': 'talk', 'Walk_Loop': 'walk', 'Walk_Formal_Loop': 'walk_formal',
    'Jog_Fwd_Loop': 'jog', 'Sprint_Loop': 'sprint', 'Jump_Start': 'jump_start', 'Jump_Loop': 'jump_loop',
    'Jump_Land': 'jump_land', 'Punch_Jab': 'jab', 'Punch_Cross': 'cross', 'Pistol_Idle_Loop': 'pistol_idle',
    'Pistol_Aim_Neutral': 'aim', 'Pistol_Aim_Up': 'aim_up', 'Pistol_Aim_Down': 'aim_down', 'Pistol_Shoot': 'shoot',
    'Pistol_Reload': 'reload', 'Hit_Chest': 'hit_chest', 'Hit_Head': 'hit_head', 'Death01': 'death',
    'Driving_Loop': 'drive', 'Sitting_Idle_Loop': 'sit', 'Sitting_Talking_Loop': 'sit_talk', 'Interact': 'interact',
    'PickUp_Table': 'pickup', 'Dance_Loop': 'dance', 'Roll': 'roll', 'Crouch_Idle_Loop': 'crouch',
    'Crouch_Fwd_Loop': 'crouch_walk',
    'Idle_TalkingPhone_Loop': 'phone', 'Idle_FoldArms_Loop': 'fold_arms', 'Yes': 'yes', 'Idle_No_Loop': 'no',
    'Consume': 'eat', 'Hit_Knockback': 'knockback', 'LayToIdle': 'get_up', 'Walk_Carry_Loop': 'walk_carry',
    'Melee_Hook': 'hook',
}
CYCLES = {'walk', 'walk_formal', 'jog', 'sprint', 'crouch_walk', 'walk_carry'}

# Blender (z up, the actor faces -y, their right is -x) -> game (x forward, y up, z right)
M = Matrix(((0, -1, 0), (0, 0, 1), (-1, 0, 0)))
MT = M.transposed()


def shortest(a, b):
    """The rotation that turns direction a onto direction b by the shortest way."""
    return a.rotation_difference(b).to_matrix()


def main():
    files = sys.argv[sys.argv.index('--') + 1:]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    out = {'fps': FPS, 'bones': BONES, 'source': 'Universal Animation Library 1+2 by Quaternius (CC0)',
           'qs': QS, 'hs': HS, 'clips': {}}
    data = array.array('h')
    for path in files:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=path)
        scene = bpy.context.scene
        arm = next(o for o in scene.objects if o.type == 'ARMATURE')
        mw = arm.matrix_world
        rest = {b.name: mw @ b.matrix_local for b in arm.data.bones}
        head = lambda m: M @ m.to_translation()
        hip_h = head(rest['pelvis']).y            # the actor's hip height, for scaling the hips' movement
        leg = ((head(rest['thigh_l']) - head(rest['calf_l'])).length + (head(rest['calf_l']) - head(rest['foot_l'])).length)
        pelvis0 = head(rest['pelvis'])

        # the fixed offset per bone: source rest rotation (limbs turned to point like ours)
        offset = {}
        for ob in BONES:
            sb, sc = MAP[ob]
            R0 = M @ rest[sb].to_3x3().normalized() @ MT
            if ob not in LIMBS:
                fix = Matrix.Identity(3)          # both stand upright in a T-pose: the torso, head, hands and feet copy as they are
            else:
                d_src = (head(rest[sc]) - head(rest[sb])).normalized()
                a, b = OUR[ob], OUR[CHILD[ob]]
                d_our = Vector((b[0] - a[0], b[1] - a[1], b[2] - a[2])).normalized()
                fix = shortest(d_src, d_our)
            offset[ob] = (fix @ R0).transposed()

        for act in bpy.data.actions:
            src_name = act.name.rsplit('_', 1)[0] if act.name.endswith('_Armature') else act.name
            if src_name not in CLIPS: continue
            name = CLIPS[src_name]
            arm.animation_data.action = act
            f0, f1 = act.frame_range
            dur = (f1 - f0) / scene.render.fps
            loop = src_name.endswith('_Loop')
            n = max(2, round(dur * FPS) + (0 if loop else 1))
            q = {b: [] for b in BONES}
            hip, feet = [], {'L': [], 'R': []}
            for i in range(n):
                t = i / FPS
                fr = f0 + t * scene.render.fps
                scene.frame_set(int(math.floor(fr)), subframe=fr - math.floor(fr))
                W = {}
                for ob in BONES:
                    pb = arm.pose.bones[MAP[ob][0]]
                    R = M @ (mw @ pb.matrix).to_3x3().normalized() @ MT
                    W[ob] = R @ offset[ob]
                for ob in BONES:
                    L = W[ob] if ob == 'hips' else W[PARENT[ob]].transposed() @ W[ob]
                    qq = L.to_quaternion().normalized()
                    q[ob].append(qq)
                p = M @ (mw @ arm.pose.bones['pelvis'].matrix).to_translation()
                hip.append((p - pelvis0) / leg)          # in leg lengths: how much the hips drop depends on the legs
                for s, bn in (('L', 'ball_l'), ('R', 'ball_r')):   # the ball of the foot: what stays on the ground
                    fp = M @ (mw @ arm.pose.bones[bn].matrix).to_translation()
                    feet[s].append(((fp - p) / hip_h, fp.y / hip_h))
            # keep each bone's quaternions on one side so blending never takes the long way round
            for ob in BONES:
                for i in range(1, n):
                    if q[ob][i].dot(q[ob][i - 1]) < 0: q[ob][i] = -q[ob][i]
            # frames of [17 bones x quaternion xyzw, hips xyz], as 16-bit integers in ual.bin
            clip = {'dur': round(dur, 4), 'n': n, 'loop': loop, 'at': len(data) * 2}
            for i in range(n):
                for ob in BONES: data.extend(int(round(v * QS)) for v in (q[ob][i].x, q[ob][i].y, q[ob][i].z, q[ob][i].w))
                data.extend(int(round(max(-3.9, min(3.9, v)) * HS)) for v in (hip[i].x, hip[i].y, hip[i].z))
            if name in CYCLES:
                # ground speed: while a foot is planted it slides back under the body at the walking speed
                speeds, land = [], None
                for s in ('L', 'R'):
                    ys = [y for _, y in feet[s]]
                    lo = min(ys)
                    planted = [y < lo + 0.02 for y in ys]
                    for i in range(n):
                        j = (i + 1) % n
                        if planted[i] and planted[j]:
                            speeds.append(-(feet[s][j][0].x - feet[s][i][0].x) * FPS)
                    if s == 'L':
                        for i in range(n):
                            if planted[i] and not planted[i - 1]: land = i / n; break
                speeds.sort()
                # in leg lengths (hip to ankle) per second: a stride is as long as the legs that take it
                clip['speed'] = round(speeds[len(speeds) // 2] * hip_h / leg, 4) if speeds else 0
                clip['land'] = round(land or 0, 4)                                     # left foot lands, 0..1
            out['clips'][name] = clip
            print(f"{name:12s} <- {src_name:24s} {dur:5.2f}s {n:3d} frames" + (f"  speed {clip['speed'] * leg:.2f} m/s for the actor, left foot lands at {clip['land']:.2f}" if 'speed' in clip else ''), flush=True)
    with open(OUT, 'w') as f: json.dump(out, f, separators=(',', ':'))
    data.tofile(open(OUT.replace('.json', '.bin'), 'wb'))
    print('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB +', len(data) * 2 // 1024, 'KB')


main()
