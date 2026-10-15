/** How hw-write-guard treats a hardware write: ask first, toast and let it run, or no check at all. */
export type Mode = 'ask' | 'notify' | 'off'

declare module 'claude-code' {
  interface PluginState {
    'hw-write-guard': {
      /** the mode /hw-guard last set ('ask' when never set), for other mods to show (mission-control's band) */
      mode: Mode
    }
  }
}
