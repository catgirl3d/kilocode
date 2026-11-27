// fork_change - new file
import type { KiloPassState, ProfileData } from "../types/messages"

// The profile card is shown for personal accounts even without a pass, so the
// card and the ring must share the visibility rule but not the pass nullability.
export const showsKiloPass = (data: ProfileData | null | undefined): data is ProfileData => {
  if (!data) return false
  if ((data.currentOrgId ?? null) !== null) return false
  return data.profile.hasPersonalAccount !== false
}

export const visibleKiloPass = (data: ProfileData | null | undefined): KiloPassState | undefined => {
  if (!showsKiloPass(data)) return undefined
  return data.kiloPass ?? undefined
}
