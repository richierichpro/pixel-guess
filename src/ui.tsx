/**
 * The single UI renderer for the whole scene. Switches on the app screen:
 * the mode-select menu, or the active mode's own HUD.
 */

import ReactEcs, { ReactEcsRenderer, UiEntity, Label, Button } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import {
  Screen,
  getScreen,
  goMenu,
  goSinglePlayerMenu,
  enterMultiplayer,
  enterGuess,
  enterDraw
} from './app'
import { gameHud } from './game/hud'
import { guessHud } from './gallery/guess'
import { drawHud } from './gallery/draw'
import { play } from './sound'

const BG = Color4.create(0.07, 0.09, 0.13, 1)
const CARD = Color4.create(0.12, 0.15, 0.2, 1)
const GOLD = Color4.create(1, 0.85, 0.35, 1)
const WHITE = Color4.White()

export function setupUi(): void {
  ReactEcsRenderer.setUiRenderer(root)
}

const root = () => {
  const s = getScreen()
  if (s === Screen.Multiplayer) return gameHud()
  if (s === Screen.Guess) return guessHud()
  if (s === Screen.Draw) return drawHud()
  return menu(s)
}

function bigButton(label: string, sub: string, color: Color4, act: () => void) {
  return (
    <UiEntity
      uiTransform={{ width: 300, height: 96, margin: { top: 14 }, flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}
      uiBackground={{ color }}
      // onMouseUp, not onMouseDown: these buttons swap the entire mounted UI
      // tree (menu -> guessHud/drawHud/gameHud), each behind its own
      // full-screen `pointerFilter:'block'` wrapper. Removing that wrapper on
      // mouseDOWN cuts the tap off mid-gesture, before its matching touch-up
      // reaches anything — a documented pointer-capture gotcha that can leave
      // the explorer thinking a touch is still down, freezing movement on
      // the screen that follows.
      onMouseUp={() => {
        play('click')
        act()
      }}
    >
      <Label value={label} fontSize={24} color={WHITE} uiTransform={{ width: '100%', height: 32 }} />
      <Label value={sub} fontSize={13} color={Color4.create(1, 1, 1, 0.75)} uiTransform={{ width: '100%', height: 20 }} />
    </UiEntity>
  )
}

function menu(s: Screen) {
  return (
    // This is the FIRST screen shown on entering the scene — it used to have
    // `pointerFilter:'block'` on this full-screen 100%x100% root, the exact
    // anti-pattern that caused DRAW mode's box-shaped dead-zone bug (see
    // draw.tsx). Since this menu is the very first thing every player sees,
    // it's the most likely explanation for camera/movement dying the moment
    // the scene loads, before any canvas or mode is even touched. Scoped
    // down to just the card below, same fix as DRAW mode.
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        width: '100%',
        height: '100%',
        justifyContent: 'center',
        alignItems: 'center'
      }}
      uiBackground={{ color: BG }}
    >
      <UiEntity uiTransform={{ width: 380, flexDirection: 'column', alignItems: 'center', padding: 28, pointerFilter: 'block' }} uiBackground={{ color: CARD }}>
        <Label value="PIXEL GUESS" fontSize={30} color={GOLD} uiTransform={{ width: '100%', height: 40 }} />

        {s === Screen.Menu ? (
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center', margin: { top: 8 } }}>
            <Label value="Choose a mode" fontSize={14} color={Color4.create(1, 1, 1, 0.7)} uiTransform={{ width: '100%', height: 24 }} />
            {bigButton('SINGLE PLAYER', 'roam the gallery, beat the clock', Color4.create(0.2, 0.5, 0.75, 1), goSinglePlayerMenu)}
            {bigButton('MULTIPLAYER', 'draw & guess with others', Color4.create(0.3, 0.55, 0.32, 1), enterMultiplayer)}
          </UiEntity>
        ) : (
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center', margin: { top: 8 } }}>
            <Label value="Single player" fontSize={14} color={Color4.create(1, 1, 1, 0.7)} uiTransform={{ width: '100%', height: 24 }} />
            {bigButton('GUESS', 'walk to each canvas, name the drawing', Color4.create(0.2, 0.5, 0.75, 1), enterGuess)}
            {bigButton('DRAW', 'add your drawing to the gallery', Color4.create(0.55, 0.4, 0.7, 1), enterDraw)}
            <Button
              value="< back"
              fontSize={13}
              uiTransform={{ width: 120, height: 34, margin: { top: 16 } }}
              color={WHITE}
              uiBackground={{ color: Color4.create(0.25, 0.27, 0.32, 1) }}
              onMouseUp={() => {
                play('click')
                goMenu()
              }}
            />
          </UiEntity>
        )}
      </UiEntity>
    </UiEntity>
  )
}
