import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { invokeNativeHookRelayBridge } from "./native-hook-relay-client.js";
import { registerNativeHookRelay, testing } from "./native-hook-relay.js";

function registerAgentRelay(
  overrides: Partial<Parameters<typeof registerNativeHookRelay>[0]> = {},
) {
  return registerNativeHookRelay({
    provider: "codex",
    relayId: `overlap-${randomUUID()}`,
    sessionId: "session-1",
    runId: "run-1",
    agentId: "agent-1",
    sessionKey: "agent:main:session-1",
    ...overrides,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  await testing.clearNativeHookRelaysForTests();
});

describe("native hook relay overlapping owners", () => {
  it("routes overlapping same-generation turns to their exact run owners", async () => {
    const relayId = `overlapping-turn-owners-${randomUUID()}`;
    const first = registerNativeHookRelay({
      provider: "codex",
      relayId,
      generation: "shared-generation",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });
    const second = registerNativeHookRelay({
      provider: "codex",
      relayId,
      generation: "shared-generation",
      sessionId: "session-1",
      runId: "run-2",
      allowedEvents: ["post_tool_use"],
    });
    await Promise.all([first.ready, second.ready]);
    first.claimTurn?.("turn-1");
    second.claimTurn?.("turn-2");

    for (const [turnId, toolUseId] of [
      ["turn-1", "call-1"],
      ["turn-2", "call-2"],
    ] as const) {
      await expect(
        invokeNativeHookRelayBridge({
          provider: "codex",
          relayId,
          generation: "shared-generation",
          event: "post_tool_use",
          timeoutMs: 2_000,
          rawPayload: {
            hook_event_name: "PostToolUse",
            turn_id: turnId,
            tool_name: "Bash",
            tool_use_id: toolUseId,
            tool_input: { command: "/bin/echo ok" },
            tool_response: { output: "ok", exit_code: 0 },
          },
        }),
      ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    }

    expect(testing.getNativeHookRelayInvocationsForTests()).toMatchObject([
      { turnId: "turn-1", toolUseId: "call-1" },
      { turnId: "turn-2", toolUseId: "call-2" },
    ]);
    first.unregister();
    await expect(
      invokeNativeHookRelayBridge({
        provider: "codex",
        relayId,
        generation: "shared-generation",
        event: "post_tool_use",
        timeoutMs: 2_000,
        rawPayload: {
          hook_event_name: "PostToolUse",
          turn_id: "turn-1",
          tool_name: "Bash",
          tool_use_id: "late-call-1",
          tool_input: { command: "/bin/echo late" },
          tool_response: { output: "late", exit_code: 0 },
        },
      }),
    ).rejects.toThrow("native hook relay bridge stale registration");
    second.unregister();
  });

  it("verifies harmless startup policy and keeps protected mutations denied", async () => {
    const protectedPath = "/protected/ax3710-guard/index.js";
    const beforeToolCall = vi.fn(async () => ({}));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const relay = registerAgentRelay({
      runId: "run-readiness",
      allowedEvents: ["pre_tool_use"],
    });
    await relay.ready;
    relay.claimTurn?.("turn-readiness");
    await expect(relay.verifyPreToolUse?.("turn-readiness")).resolves.toBeUndefined();

    for (const [toolUseId, command] of [
      ["pwd-canary", "pwd"],
      ["status-canary", "git status --short --branch"],
      ["echo-canary", "/bin/echo ok"],
    ] as const) {
      await expect(
        invokeNativeHookRelayBridge({
          provider: "codex",
          relayId: relay.relayId,
          generation: relay.generation,
          event: "pre_tool_use",
          timeoutMs: 2_000,
          rawPayload: {
            hook_event_name: "PreToolUse",
            turn_id: "turn-readiness",
            tool_name: "Bash",
            tool_use_id: toolUseId,
            tool_input: { command },
          },
        }),
      ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    }

    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: vi.fn(async () => ({
            block: true,
            blockReason: "protected enforcement infrastructure",
          })),
        },
      ]),
    );
    const protectedRelay = registerAgentRelay({
      runId: "run-protected-canary",
      allowedEvents: ["pre_tool_use"],
    });
    await protectedRelay.ready;
    protectedRelay.claimTurn?.("turn-protected-canary");
    const denied = await invokeNativeHookRelayBridge({
      provider: "codex",
      relayId: protectedRelay.relayId,
      generation: protectedRelay.generation,
      event: "pre_tool_use",
      timeoutMs: 2_000,
      rawPayload: {
        hook_event_name: "PreToolUse",
        turn_id: "turn-protected-canary",
        tool_name: "Bash",
        tool_use_id: "protected-mutation-canary",
        tool_input: { command: `/usr/bin/touch -r ${protectedPath} ${protectedPath}` },
      },
    });
    expect(JSON.parse(denied.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "protected enforcement infrastructure",
      },
    });
    protectedRelay.unregister();
    relay.unregister();
  });

  it("accepts an intentional policy denial as a serviced readiness probe", async () => {
    const policy = vi.fn(async () => ({
      block: true,
      blockReason: "fixture policy denied readiness",
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: policy }]),
    );
    const relay = registerAgentRelay({
      runId: "run-denied-readiness",
      allowedEvents: ["pre_tool_use"],
    });
    await relay.ready;
    relay.claimTurn?.("turn-denied-readiness");

    await expect(relay.verifyPreToolUse?.("turn-denied-readiness")).resolves.toBeUndefined();
    expect(policy).toHaveBeenCalledOnce();
    relay.unregister();
  });
});
