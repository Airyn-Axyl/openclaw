import { randomUUID } from "node:crypto";
import { invokeNativeHookRelayBridge } from "./native-hook-relay-client.js";
import type { NativeHookRelayProvider } from "./native-hook-relay-types.js";

class NativeHookRelayReadinessResponseError extends Error {}

export async function verifyNativeHookRelayPreToolUseReadiness(params: {
  provider: NativeHookRelayProvider;
  relayId: string;
  generation: string;
  readinessNonce: string;
  sessionId: string;
  turnId: string;
  recover: () => Promise<void>;
}): Promise<void> {
  const invokeProbe = async () => {
    const response = await invokeNativeHookRelayBridge({
      provider: params.provider,
      relayId: params.relayId,
      generation: params.generation,
      readinessNonce: params.readinessNonce,
      event: "pre_tool_use",
      timeoutMs: 2_000,
      registrationTimeoutMs: 250,
      rawPayload: {
        hook_event_name: "PreToolUse",
        session_id: params.sessionId,
        turn_id: params.turnId,
        tool_name: "Bash",
        tool_use_id: `openclaw-relay-readiness-${randomUUID()}`,
        tool_input: { command: "/bin/echo ok" },
      },
    });
    if (
      response.exitCode !== 0 ||
      response.stderr.trim().length > 0 ||
      response.failureDisposition !== undefined
    ) {
      throw new NativeHookRelayReadinessResponseError(
        "native hook relay readiness probe returned a hook failure",
      );
    }
  };
  try {
    await invokeProbe();
  } catch (error) {
    if (error instanceof NativeHookRelayReadinessResponseError) {
      throw error;
    }
    try {
      await params.recover();
      await invokeProbe();
    } catch (retryError) {
      const message = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(`native hook relay readiness failed (direct bridge): ${message}`, {
        cause: retryError,
      });
    }
  }
}
