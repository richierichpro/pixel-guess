/**
 * Shared helpers for the server-baked painting atlas.
 *
 * The 12 paintings are split across 3 separate atlas IMAGES of 4 tiles each
 * (a single row per image) — not one shared 4x3 grid, and not one 12-wide
 * strip. History, in order:
 *  - 4x3 grid (one image, 576x432): a tile's row was selected via a V-axis
 *    flip ("atlas row 0 is the top of the image, but uv v=0 is the bottom").
 *    That flip's direction turned out to be a renderer convention desktop
 *    and mobile disagreed on — a row-0 painting rendered as the row-2
 *    painting on MOBILE only, an exact swap under 3 rows, not a blur/bleed
 *    artifact.
 *  - single row of 12 (one image, 1728x144): removes row-selection entirely
 *    (fixed mobile), but the extreme 12:1 aspect ratio broke DESKTOP instead
 *    — same image file, only desktop rendered it as corrupted vertical
 *    stripes (a mip/LOD artifact tied to the very elongated width).
 *  - 4-per-image, 3 images (this version): each image is still a single row
 *    (no row-selection math, so no mobile V-flip bug) AND each image's width
 *    matches the ORIGINAL 576px dimension that was always safe on desktop
 *    (so no extreme-aspect-ratio bug either). Costs 3 fetches instead of 1.
 * Each painting is baked at SCALE px/painting-px with a PAD-px border that
 * repeats its OWN edge pixels — not empty space, not the neighbor's pixels —
 * so a blurred mip level bleeds into more of the same painting instead of
 * into the one next to it. MUST match server/main.ts's SCALE/PAD/GRID/
 * GROUP_SIZE exactly, or tiles sample the wrong region. A canvas plane
 * samples its tile via the texture's offset/tiling, so we use the default
 * plane UVs untouched.
 */

import { Material, TextureFilterMode, TextureWrapMode, type Entity } from '@dcl/sdk/ecs'
import { Vector2, Color4 } from '@dcl/sdk/math'

export const BACKEND = 'https://drawing-server-production-901f.up.railway.app'

export const GROUP_SIZE = 4 // tiles per atlas image (single row each)
export const SLOTS = 12
const GROUPS = SLOTS / GROUP_SIZE // 3

const GRID = 16
const SCALE = 8
const PAD = 8
const CELL_PX = GRID * SCALE // 128
const BLOCK = CELL_PX + PAD * 2 // 144
const FRAC_INSET = PAD / BLOCK // where the real painting starts, within one block
const FRAC_CELL = CELL_PX / BLOCK // how much of one block is the real painting

export interface Tile {
  id: string
  word: string
  cells: number[] // the raw 256-cell painting, for a pixel-perfect close-up view
}

export interface Gallery {
  atlasUrls: string[] // one per group, length === GROUPS
  tiles: Tile[]
}

export async function fetchGallery(): Promise<Gallery> {
  const res = await fetch(`${BACKEND}/gallery`)
  return (await res.json()) as Gallery
}

/** Point a plane at slot `i` — picks the right one of the 3 atlas images and its column within it. */
export function applyTile(entity: Entity, atlasUrls: string[], i: number): void {
  const group = Math.floor(i / GROUP_SIZE)
  const col = i % GROUP_SIZE
  Material.setBasicMaterial(entity, {
    castShadows: false,
    texture: Material.Texture.Common({
      src: atlasUrls[group] ?? atlasUrls[0],
      filterMode: TextureFilterMode.TFM_POINT, // crisp pixels
      wrapMode: TextureWrapMode.TWM_CLAMP,
      // Single row per image — v is just inset past the top/bottom PAD
      // border, no row math (that's what caused the mobile V-flip bug).
      // Inset past the tile's PAD border into the actual painted region.
      offset: Vector2.create((col + FRAC_INSET) / GROUP_SIZE, 1 - FRAC_INSET - FRAC_CELL),
      tiling: Vector2.create(FRAC_CELL / GROUP_SIZE, FRAC_CELL)
    })
  })
}

export function blankCanvas(entity: Entity): void {
  // an empty easel — a plain light canvas, not a dark hole
  Material.setBasicMaterial(entity, { diffuseColor: Color4.create(0.93, 0.93, 0.9, 1), castShadows: false })
}

export function verOf(url: string): number {
  const m = url.match(/[?&]v=(\d+)/)
  return m ? Number(m[1]) : 0
}

export function normalizeWord(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}
