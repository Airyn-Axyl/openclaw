import { NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR } from "./native-hook-relay-client.js";
import {
  nativeHookRelayRegistrationsById,
  nativeHookRelayState,
} from "./native-hook-relay-state.js";
import type {
  ActiveNativeHookRelayRegistration,
  NativeHookRelayRegistrationHandle,
  NativeHookRelayRegistration,
  RelayLifetime,
} from "./native-hook-relay-types.js";
import { isJsonObject } from "./native-hook-relay-utils.js";

const MAX_NATIVE_HOOK_RELAY_TURN_CLAIMS = 32;
const { relays } = nativeHookRelayState;

export async function claimAndVerifyRelayTurn(
  handle: Pick<NativeHookRelayRegistrationHandle, "claimTurn" | "verifyPreToolUse">,
  turnId: string,
  assertCurrent?: () => void,
  bindProcessAuthority?: () => void,
): Promise<void> {
  handle.claimTurn?.(turnId);
  bindProcessAuthority?.();
  assertCurrent?.();
  await handle.verifyPreToolUse?.(turnId);
  assertCurrent?.();
}

export function normalizeNativeHookRelayKey(
  value: string | undefined,
  kind: "id" | "generation",
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 160 || !/^[A-Za-z0-9._:-]+$/u.test(trimmed)) {
    throw new Error(`native hook relay ${kind} must be non-empty, compact, and URL-safe`);
  }
  return trimmed;
}

export function canAcceptNativeHookRelayGenerationMismatch(
  registration: NativeHookRelayRegistration,
  generation: string,
): boolean {
  const expiresAtMs = registration.generationMismatchGraceExpiresAtMs;
  if (typeof expiresAtMs !== "number" || Date.now() > expiresAtMs) {
    return false;
  }
  if (registration.generationMismatchGraceAcceptedGeneration) {
    return registration.generationMismatchGraceAcceptedGeneration === generation;
  }
  registration.generationMismatchGraceAcceptedGeneration = generation;
  return true;
}

export function latestNativeHookRelayRegistration(
  registrations: Set<ActiveNativeHookRelayRegistration> | undefined,
): ActiveNativeHookRelayRegistration | undefined {
  let latest: ActiveNativeHookRelayRegistration | undefined;
  for (const registration of registrations ?? []) {
    latest = registration;
  }
  return latest;
}

export function isLiveNativeHookRelayRegistration(
  relayId: string,
  registration: ActiveNativeHookRelayRegistration,
): boolean {
  return (
    nativeHookRelayRegistrationsById.get(relayId)?.has(registration) === true ||
    relays.get(relayId) === registration
  );
}

export function ensureNativeHookRelayTurnClaims(
  registration: ActiveNativeHookRelayRegistration,
): Set<string> {
  if (!(registration.claimedTurnIds instanceof Set)) {
    registration.claimedTurnIds = new Set();
  }
  return registration.claimedTurnIds;
}

export function claimNativeHookRelayTurn(params: {
  relayId: string;
  registration: ActiveNativeHookRelayRegistration;
  turnIdInput: string;
  onDuplicate: (sibling: ActiveNativeHookRelayRegistration) => void;
}): void {
  const turnId = params.turnIdInput.trim();
  if (!turnId || !isLiveNativeHookRelayRegistration(params.relayId, params.registration)) {
    return;
  }
  const claimedTurnIds = ensureNativeHookRelayTurnClaims(params.registration);
  for (const sibling of nativeHookRelayRegistrationsById.get(params.relayId) ?? []) {
    if (sibling !== params.registration && ensureNativeHookRelayTurnClaims(sibling).has(turnId)) {
      params.onDuplicate(sibling);
      return;
    }
  }
  if (claimedTurnIds.size >= MAX_NATIVE_HOOK_RELAY_TURN_CLAIMS && !claimedTurnIds.has(turnId)) {
    const oldest = claimedTurnIds.values().next().value;
    if (oldest) {
      claimedTurnIds.delete(oldest);
    }
  }
  claimedTurnIds.add(turnId);
}

export function resolveNativeHookRelayInvocationTarget(params: {
  relayId: string;
  requestedGeneration: string | undefined;
  rawPayload: unknown;
  readLifetime: (registration: ActiveNativeHookRelayRegistration) => RelayLifetime | undefined;
}): ActiveNativeHookRelayRegistration | undefined {
  const registrations = nativeHookRelayRegistrationsById.get(params.relayId);
  if (!registrations?.size) {
    return relays.get(params.relayId);
  }

  let childOwner: ActiveNativeHookRelayRegistration | undefined;
  let childOwnerCount = 0;
  for (const candidate of registrations) {
    const retention = params.readLifetime(candidate)?.retention;
    if (!retention) {
      continue;
    }
    try {
      const claim = retention.readClaim(params.rawPayload);
      if (claim && retention.allowPreToolUse(claim)) {
        childOwner = candidate;
        childOwnerCount += 1;
      }
    } catch {
      // A throwing ownership probe grants no routing authority.
    }
  }
  if (childOwnerCount === 1) {
    return childOwner;
  }
  if (childOwnerCount > 1) {
    throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
  }

  const turnId =
    isJsonObject(params.rawPayload) && typeof params.rawPayload.turn_id === "string"
      ? params.rawPayload.turn_id.trim()
      : "";
  if (turnId) {
    const owners = [...registrations].filter((candidate) =>
      ensureNativeHookRelayTurnClaims(candidate).has(turnId),
    );
    if (owners.length === 1) {
      return owners[0];
    }
    // Every accepted modern Codex turn is claimed before hooks can execute.
    // Never let a late or unknown turn downgrade to generation/latest routing,
    // including after its original overlapping owner has already exited.
    throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
  }

  const generationMatches = params.requestedGeneration
    ? [...registrations].filter((candidate) => candidate.generation === params.requestedGeneration)
    : [];
  if (generationMatches.length === 1) {
    return generationMatches[0];
  }
  if (generationMatches.length > 1) {
    throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
  }
  return latestNativeHookRelayRegistration(registrations);
}
