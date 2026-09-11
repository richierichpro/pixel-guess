import {} from '@dcl/sdk/math'
import { setupUi } from './ui'
import { bootMultiplayer } from './app'

export function main() {
  bootMultiplayer() // every client races to claim the synced singletons at boot
  setupUi() // mode-select menu → multiplayer game, or single-player gallery (guess / draw)
}
