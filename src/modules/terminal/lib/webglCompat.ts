import { invoke } from "@tauri-apps/api/core";

export type WebglCompat = {
  sessionType: string | null;
};

type RawCompat = { session_type: string | null } | null;

/**
 * Decide whether the *default* (when the user has not chosen) should disable
 * the xterm WebGL renderer. Today this is Linux + Wayland, where WebKitGTK
 * 2.52+ stops flushing WebGL `<canvas>` rAF composites until a user input
 * event — so terminal writes only paint when the pane is re-clicked. Power
 * users can still opt back in via Settings; this only affects the unset case.
 *
 * Keep this pure so it can be unit-tested without Tauri.
 */
export function shouldDefaultDisableWebgl(
  sessionType: string | null | undefined,
): boolean {
  return sessionType != null && sessionType.toLowerCase() === "wayland";
}

/**
 * Returns the desktop session type (XDG_SESSION_TYPE) or null off-platform.
 * Resolves to null when the Tauri command is unavailable (tests / non-Tauri),
 * so the default stays "WebGL on" everywhere we can't determine the host.
 */
export async function fetchWebglCompat(): Promise<WebglCompat> {
  try {
    const raw = (await invoke("webgl_compat_check")) as RawCompat;
    return { sessionType: raw?.session_type ?? null };
  } catch {
    return { sessionType: null };
  }
}