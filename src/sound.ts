/**
 * Central sound effect player. One small pool of global (non-spatial)
 * AudioSource entities, round-robin so overlapping triggers don't cut each
 * other off. Retriggering uses `AudioSource.playSound`, which reliably
 * restarts a clip from 0 even with identical params (hand-mutating `playing`
 * gets silently deduped by the CRDT).
 */

import { engine, AudioSource, Transform, type Entity } from '@dcl/sdk/ecs'

const FILES = {
  click: 'assets/Audio/click.mp3',
  correct: 'assets/Audio/correct.mp3',
  wrong: 'assets/Audio/wrong.mp3',
  tick: 'assets/Audio/tick.mp3',
  timesUp: 'assets/Audio/times-up.mp3',
  roundStart: 'assets/Audio/round-start.mp3',
  reveal: 'assets/Audio/reveal.mp3',
  youGotIt: 'assets/Audio/you-got-it.mp3',
  gameOver: 'assets/Audio/game-over.mp3',
  join: 'assets/Audio/join.mp3',
  discard: 'assets/Audio/discard.mp3'
} as const

export type SoundName = keyof typeof FILES

const POOL_SIZE = 4
const pool: Entity[] = []
let nextSlot = 0

function ensurePool(): void {
  if (pool.length) return
  for (let i = 0; i < POOL_SIZE; i++) {
    const e = engine.addEntity()
    // Sound position is read from Transform even when global — give every source
    // one explicitly rather than relying on an implicit default.
    Transform.create(e, {})
    AudioSource.create(e, { audioClipUrl: FILES.click, playing: false, global: true, volume: 0.85 })
    pool.push(e)
  }
}

export function play(name: SoundName): void {
  ensurePool()
  const e = pool[nextSlot]
  nextSlot = (nextSlot + 1) % POOL_SIZE
  AudioSource.playSound(e, FILES[name])
}
