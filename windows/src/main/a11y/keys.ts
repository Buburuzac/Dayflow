// Which key combinations are logged as shortcuts. The helper sends only a virtual-key code,
// modifier bits and a numpad flag for keys pressed with Ctrl, Alt or Win held; everything not on
// this allowlist counts as typing (the field is read back as a whole later, never key by key).
//
// Never shortcuts:
//   - Ctrl+Alt + anything (Ctrl+Alt == AltGr, which types characters on PL/DE/CZ/… layouts),
//     except Ctrl+Alt+Tab.
//   - Alt + numpad keys (Alt codes type characters), Alt + character keys.
//   - Any key on the numpad.
// The recorder additionally drops every shortcut while a password field has focus.

export const MOD_CTRL = 1
export const MOD_ALT = 2
export const MOD_SHIFT = 4
export const MOD_WIN = 8

const NAV: Record<number, string> = {
  0x21: 'PageUp',
  0x22: 'PageDown',
  0x23: 'End',
  0x24: 'Home',
  0x25: 'Left',
  0x26: 'Up',
  0x27: 'Right',
  0x28: 'Down',
}

/** Ctrl (+Shift) + these letters: clipboard, undo/redo, select all, save, find, tabs, windows, reload. */
const CTRL_LETTERS = new Set('CVXZYASFTWNR'.split(''))

function isFKey(vk: number): boolean {
  return vk >= 0x70 && vk <= 0x87
}

function baseName(vk: number): string | null {
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk)
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk)
  if (isFKey(vk)) return 'F' + (vk - 0x6f)
  if (NAV[vk]) return NAV[vk]
  switch (vk) {
    case 0x08:
      return 'Backspace'
    case 0x09:
      return 'Tab'
    case 0x1b:
      return 'Esc'
    case 0x20:
      return 'Space'
    case 0x2d:
      return 'Insert'
    case 0x2e:
      return 'Delete'
  }
  return null
}

/**
 * The shortcut's display form ("Ctrl+Shift+T"), or null when the combination must not be
 * logged (it is treated as typing).
 */
export function shortcutName(vk: number, mods: number, numpad: boolean): string | null {
  if (!Number.isInteger(vk) || !Number.isInteger(mods) || numpad) return null
  if (vk >= 0x60 && vk <= 0x6f) return null // numpad digits and operators, whatever the flag says
  const ctrl = (mods & MOD_CTRL) !== 0
  const alt = (mods & MOD_ALT) !== 0
  const shift = (mods & MOD_SHIFT) !== 0
  const win = (mods & MOD_WIN) !== 0
  if (!ctrl && !alt && !win) return null
  const name = baseName(vk)
  if (name === null) return null // OEM keys (punctuation, ß, ą, …) and anything unknown

  let ok = false
  if (win) {
    // Win combinations never type text.
    ok = true
  } else if (ctrl && alt) {
    ok = vk === 0x09
  } else if (ctrl) {
    ok =
      CTRL_LETTERS.has(name) ||
      isFKey(vk) ||
      vk === 0x09 ||
      vk in NAV ||
      vk === 0x08 ||
      vk === 0x2e ||
      vk === 0x2d
  } else {
    // Alt alone (+Shift): window switching, close, back/forward, window menu, F-keys.
    ok = vk === 0x09 || vk === 0x1b || vk === 0x20 || isFKey(vk) || vk in NAV
  }
  if (!ok) return null
  return (ctrl ? 'Ctrl+' : '') + (alt ? 'Alt+' : '') + (shift ? 'Shift+' : '') + (win ? 'Win+' : '') + name
}
