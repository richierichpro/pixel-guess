/**
 * The 3D display board in the world — shows the synced Grid so everyone watches
 * the drawing appear. Display only; drawing input is the 2D overlay in hud.tsx.
 *
 * Unlit (basic) materials so pixels render flat and crisp, matching the 2D canvas.
 */

import {
  engine,
  Transform,
  MeshRenderer,
  Material,
  TextShape,
  Font,
  TextAlignMode,
  VisibilityComponent,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color3, Color4 } from '@dcl/sdk/math'
import { GRID, CELL_COUNT, Phase, PALETTE, blankColor, state, grid, maskedWord, remainingMs } from './state'
import { getScreen, Screen } from '../app'

const PITCH = 0.22
const HALF = ((GRID - 1) * PITCH) / 2
const SPAN = GRID * PITCH // ~3.5 m
const CENTER = Vector3.create(24, 2.8, 38) // ahead of the spawn point
const Z_CELL = -0.004
const Z_UI = -0.03
const Z_FRAME = 0.006

const COLOR_FRAME = Color4.create(0.36, 0.72, 0.9, 1) // same light blue as the drawing canvas
const COLOR_BACKING = Color4.create(1, 1, 1, 1)
const COLOR_INK = Color4.create(0.1, 0.15, 0.2, 1)
const WHITE3 = Color3.create(1, 1, 1)

const cells: Entity[] = []
const shown = new Int8Array(CELL_COUNT).fill(-1)
let wordText: Entity
let timerText: Entity
let boardRoot: Entity
let boardShown = false

const flat = (e: Entity, color: Color4) => Material.setBasicMaterial(e, { diffuseColor: color, castShadows: false })

export function setupBoard(): void {
  const root = engine.addEntity()
  Transform.create(root, { position: CENTER, rotation: Quaternion.fromEulerDegrees(0, 0, 0) })
  // The board exists for every client from boot (see app.ts bootMultiplayer),
  // but it sits inside the single-player arena too — only show it while
  // actually in multiplayer. propagateToChildren hides the whole board (frame,
  // backing, 256 cells, word/timer text) with one component write.
  VisibilityComponent.create(root, { visible: false, propagateToChildren: true })
  boardRoot = root

  const frame = engine.addEntity()
  Transform.create(frame, { parent: root, position: Vector3.create(0, 0, Z_FRAME), scale: Vector3.create(SPAN + 0.22, SPAN + 0.22, 1) })
  MeshRenderer.setPlane(frame)
  flat(frame, COLOR_FRAME)

  const backing = engine.addEntity()
  Transform.create(backing, { parent: root, position: Vector3.create(0, 0, 0.002), scale: Vector3.create(SPAN + 0.04, SPAN + 0.04, 1) })
  MeshRenderer.setPlane(backing)
  flat(backing, COLOR_BACKING)

  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const cell = engine.addEntity()
      Transform.create(cell, {
        parent: root,
        position: Vector3.create(col * PITCH - HALF, HALF - row * PITCH, Z_CELL),
        scale: Vector3.create(PITCH, PITCH, 1)
      })
      MeshRenderer.setPlane(cell)
      flat(cell, blankColor(row, col))
      cells.push(cell)
    }
  }

  wordText = engine.addEntity()
  Transform.create(wordText, { parent: root, position: Vector3.create(0, HALF + 0.26, Z_UI) })
  TextShape.create(wordText, {
    text: '', font: Font.F_MONOSPACE, fontSize: 4.6, textColor: COLOR_INK,
    outlineColor: WHITE3, outlineWidth: 0.15, textAlign: TextAlignMode.TAM_MIDDLE_CENTER
  })

  timerText = engine.addEntity()
  Transform.create(timerText, { parent: root, position: Vector3.create(0, HALF + 0.62, Z_UI) })
  TextShape.create(timerText, {
    text: '', font: Font.F_MONOSPACE, fontSize: 3.6, textColor: COLOR_INK,
    outlineColor: WHITE3, outlineWidth: 0.15, textAlign: TextAlignMode.TAM_MIDDLE_CENTER
  })

  engine.addSystem(renderSystem)
}

function renderSystem(): void {
  const inMultiplayer = getScreen() === Screen.Multiplayer
  if (inMultiplayer !== boardShown) {
    boardShown = inMultiplayer
    VisibilityComponent.getMutable(boardRoot).visible = inMultiplayer
  }
  if (!inMultiplayer) return // no point diffing/updating an invisible board

  const c = grid().cells
  for (let i = 0; i < CELL_COUNT; i++) {
    const v = c[i] ?? 0
    if (shown[i] === v) continue
    shown[i] = v
    flat(cells[i], v === 0 ? blankColor(Math.floor(i / GRID), i % GRID) : (PALETTE[v] ?? PALETTE[1]).color)
  }

  const st = state()
  const showWord = st.phase === Phase.Drawing || st.phase === Phase.RoundEnd
  TextShape.getMutable(wordText).text = showWord ? maskedWord() : ''
  TextShape.getMutable(timerText).text =
    st.phase === Phase.Choosing || st.phase === Phase.Drawing ? formatMs(remainingMs()) : ''
}

function formatMs(ms: number): string {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${s % 60 < 10 ? '0' : ''}${s % 60}`
}
