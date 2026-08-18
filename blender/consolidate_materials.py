# ---------------------------------------------------------------------------
# Draw-call fix for FULLSCENE_DRACO.glb (or whatever you're currently
# exporting from). Run this INSIDE Blender, on the .blend the glb came from -
# not on the glb itself.
#
# What it does, in two passes:
#   1. Finds materials that are functionally identical (same flat base
#      color - this file has no textures, so color is the only thing that
#      matters) and repoints every mesh slot using a duplicate to one
#      canonical material, then deletes the now-unused duplicates.
#      820 materials -> ~53, matching the distinct colors actually in use.
#   2. Joins every mesh object that uses a single material into one combined
#      object per material. 2246 objects -> roughly one object per material,
#      so ~53 objects instead of 2246. In Three.js, one object with one
#      material = one draw call, so this is the number that actually matters
#      for framerate.
#
# BEFORE YOU RUN THIS:
#   - File > Save As a new copy first. bpy.ops.object.join() is destructive
#     and hard to undo cleanly at this scale - don't run it on your only copy.
#   - Run pass 1, check the result (Blender's status bar / the printed count)
#     looks right, THEN run pass 2. Don't run both blind.
#
# HOW TO RUN:
#   - Switch to the "Scripting" tab in Blender
#   - New script, paste this whole file in
#   - Click Run (the play button), watch the System Console
#     (Window > Toggle System Console on Windows; on Mac, launch Blender from
#     Terminal so you can see print() output) for the before/after counts
#
# Trade-off worth knowing: joining objects means Three.js can no longer
# frustum-cull them individually - a joined "all buildings using material X"
# mesh renders in full even if only one building in it is on screen. That's
# a good trade for a backdrop that's mostly always at least partly visible
# (this city), but would be the wrong move for objects scattered across a
# huge area where most are usually off-screen. Keep that in mind if you
# reuse this script elsewhere.
#
# AFTER: re-export to glTF with Draco compression on (same checkbox as
# before), drop the new .glb into public/models/, replacing the old one.
# ---------------------------------------------------------------------------

import bpy
from collections import defaultdict


def get_base_color(mat):
    """Return the Principled BSDF base color as a rounded tuple, or None."""
    if not mat or not mat.use_nodes or not mat.node_tree:
        return None
    for node in mat.node_tree.nodes:
        if node.type == 'BSDF_PRINCIPLED':
            return tuple(round(c, 4) for c in node.inputs['Base Color'].default_value)
    return None


def consolidate_materials():
    """Pass 1: repoint duplicate-color materials to one canonical material."""
    color_to_canonical = {}
    remap = {}  # duplicate material name -> canonical material

    for mat in list(bpy.data.materials):
        color = get_base_color(mat)
        if color is None:
            continue  # leave anything with actual textures/node graphs alone
        if color not in color_to_canonical:
            color_to_canonical[color] = mat
        else:
            remap[mat.name] = color_to_canonical[color]

    reassigned = 0
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        for slot in obj.material_slots:
            if slot.material and slot.material.name in remap:
                slot.material = remap[slot.material.name]
                reassigned += 1

    before = len(bpy.data.materials)
    bpy.ops.outliner.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
    after = len(bpy.data.materials)

    print(f"[consolidate_materials] reassigned {reassigned} slot(s)")
    print(f"[consolidate_materials] materials: {before} -> {after}")


def join_by_material():
    """Pass 2: join every single-material mesh object sharing a material."""
    by_material = defaultdict(list)
    skipped_multi = 0

    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        mats = [s.material for s in obj.material_slots if s.material]
        if len(mats) == 1:
            by_material[mats[0].name].append(obj)
        elif len(mats) > 1:
            skipped_multi += 1  # left alone - join per-material groups only

    before_count = len(bpy.data.objects)

    for mat_name, objs in by_material.items():
        if len(objs) < 2:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.join()

    bpy.ops.object.select_all(action='DESELECT')
    after_count = len(bpy.data.objects)

    print(f"[join_by_material] skipped {skipped_multi} multi-material object(s) (left as-is)")
    print(f"[join_by_material] objects: {before_count} -> {after_count}")


# Run pass 1 first. Comment this back out and uncomment join_by_material()
# once you've checked the material count looks right.
consolidate_materials()
# join_by_material()
