# Objects that must stay SEPARATE when condensing in Blender

Do not join these. **Everything else is fair game, including all 17 sign panels.**

The site finds each of these by exact name at runtime. Joining renames them,
the lookup silently fails, and whatever depended on it stops running - that's
what made the street go black in BLENDER_CONDENSER.glb.

The sign panels used to be on this list. They're not anymore: sign clicking
is disabled (SIGN_CLICKS_ENABLED in titleScreen.js) because every sign click
just did the same thing as clicking the background. Join them freely.

## Street + background buildings — recoloured/hidden at runtime

- `Plane.002`
- `tripo_node_1b17d649-d3ad-4287-9088-27fc9b46c0de`
- `tripo_node_4bae5984-e7fd-4e13-b2cc-a0c2456c2ee1.001`

## Yellow tactile strip — lifted off the sidewalk at runtime

- `Box1913`
- `Box1924`
- `Object1405100643`

## Vinyl booth interaction targets — these DO route somewhere

- `RecordPlayer_Cube.070`
- `VinylWall_Cylinder.023`
- `VinylShelf_Cube.001`
- `VinylShelf_Cube.180`
- `Counter_Cube.001`

## Misc runtime lookups

- `Object258`
- `ALLWINDOWS`

**Total: 13 objects to leave alone** (was 30 before sign clicking was dropped).

Everything else - all signage, clothing, shelves, boxes, figures, crates,
glass panes, props - can be joined.