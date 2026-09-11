/**
 * Top-level app flow: a mode-select menu that branches into the multiplayer
 * game or the single-player gallery (guess / draw).
 *
 * The multiplayer machinery (initSync/setupBoard/setupGame/setupHud) is set up
 * EAGERLY for every client at boot via bootMultiplayer() — NOT lazily on first
 * click. syncEntity's "every client registers the same fixed-id entity on its
 * own" pattern only reconciles cleanly when all clients race to register at
 * nearly the same moment (CRDT last-write-wins on the simultaneous claim). A
 * client that calls it LATE — after another client's registration has already
 * settled — is creating a genuinely different entity competing for an
 * already-owned id, which the room correctly rejects ("id already in use").
 * Confirmed live: a second player joining after the first had already entered
 * MULTIPLAYER failed every time; both racing at boot does not.
 *
 * Single-player (GUESS/DRAW) has no such constraint — it doesn't use
 * syncEntity at all — so it stays lazy, set up on first entry.
 */

import { engine, InputModifier, TouchScreenControls } from '@dcl/sdk/ecs'
import { initSync } from './game/state'
import { setupBoard } from './game/board'
import { setupGame } from './game/game'
import { setupHud, releaseMultiplayerFreeze } from './game/hud'
import { setupGuess, startGuessRound } from './gallery/guess'
import { setupDraw, startDrawRound } from './gallery/draw'

export enum Screen {
  Menu = 0,
  SinglePlayerMenu = 1,
  Multiplayer = 2,
  Guess = 3,
  Draw = 4
}

let screen = Screen.Menu
export const getScreen = (): Screen => screen

let guessReady = false
let drawReady = false

/** Call once from main() — races every client to claim the synced singletons at boot. */
export function bootMultiplayer(): void {
  initSync()
  setupBoard()
  setupGame()
  setupHud()
}

export function goSinglePlayerMenu(): void {
  screen = Screen.SinglePlayerMenu
}

export function goMenu(): void {
  screen = Screen.Menu
}

export function enterMultiplayer(): void {
  screen = Screen.Multiplayer
}

// DRAW mode's canvas sits under a full-screen `pointerFilter:'block'` UI for
// the whole 90s round (plus the choosing/done screens either side of it) — on
// mobile that's a long stretch with a modal covering the entire viewport, and
// the explorer auto-hides the on-screen movement joystick under a full-screen
// blocking UI (matching desktop's own equivalent: a modal steals input focus).
// Reported bug: after DRAW -> submit -> MENU -> GUESS, movement stayed stuck
// even though GUESS mode's own UI never blocks the screen and never calls
// InputModifier/TouchScreenControls itself — so nothing in scene code was
// hiding it, pointing at the explorer not reliably restoring the joystick
// after that particular chain of blocking screens. Defensive, idempotent
// reset on entry to either single-player mode: harmless if nothing was
// hidden, and directly undoes a stuck-hidden joystick if something was.
function resetMovement(): void {
  InputModifier.deleteFrom(engine.PlayerEntity)
  TouchScreenControls.showJoystick()
  TouchScreenControls.showAll()
  releaseMultiplayerFreeze() // clear any leaked Multiplayer canvas-freeze state too
}

export function enterGuess(): void {
  if (!guessReady) {
    setupGuess()
    guessReady = true
  }
  resetMovement()
  startGuessRound() // fresh 2-minute round + reload the gallery
  screen = Screen.Guess
}

export function enterDraw(): void {
  if (!drawReady) {
    setupDraw()
    drawReady = true
  }
  resetMovement()
  startDrawRound() // fresh word choices + blank canvas
  screen = Screen.Draw
}
