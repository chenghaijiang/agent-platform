/**
 * AgentMessageChannel — file-based agent-to-agent messaging (design doc §8.1 note, coordination).
 *
 * One JSONL inbox per agent: `{workspace}/.harness/messages/{agentId}.jsonl`. `send` appends a line
 * to the recipient's file; `drain` claims the whole mailbox by renaming it aside and then reads it,
 * so messages written during a drain land in a fresh file instead of being truncated away.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ToolManifest } from "@harness/contracts";
import type { ToolRegistry } from "../tool/registry.js";

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  sentAt: number;
}

export type MessageChannelErrorCode = "INVALID_AGENT" | "INVALID_TEXT" | "READ_FAILED";

export class MessageChannelError extends Error {
  constructor(
    readonly code: MessageChannelErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "MessageChannelError";
  }
}

export interface MessageChannelOptions {
  /** Injectable clock (tests). */
  now?: () => number;
}

/** Agent ids become filenames — keep them to a safe alphabet (no separators, no traversal). */
const AGENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export class AgentMessageChannel {
  readonly dir: string;
  private readonly now: () => number;

  constructor(
    private readonly workspace: string,
    opts: MessageChannelOptions = {},
  ) {
    this.dir = join(workspace, ".harness", "messages");
    this.now = opts.now ?? (() => Date.now());
  }

  /** Inbox path for one agent (public so the CLI can show it in diagnostics). */
  fileFor(agentId: string): string {
    return join(this.dir, `${assertAgent(agentId)}.jsonl`);
  }

  /** Append one message to the recipient's inbox. */
  async send(to: string, from: string, text: string): Promise<AgentMessage> {
    const recipient = assertAgent(to);
    const sender = assertAgent(from);
    const body = typeof text === "string" ? text.trim() : "";
    if (!body) throw new MessageChannelError("INVALID_TEXT", "消息内容不能为空");

    const message: AgentMessage = {
      id: `m_${randomUUID().slice(0, 8)}`,
      from: sender,
      to: recipient,
      text: body,
      sentAt: this.now(),
    };
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.fileFor(recipient), `${JSON.stringify(message)}\n`, "utf8");
    return message;
  }

  /** Take everything in one inbox, oldest first, and clear it. */
  async drain(agentId: string): Promise<AgentMessage[]> {
    const agent = assertAgent(agentId);
    const inbox = this.fileFor(agent);
    if (!existsSync(inbox)) return [];

    // Rename first: anything appended after this point goes to a new file and stays unread.
    const claimed = join(this.dir, `.${agent}.${randomUUID().slice(0, 8)}.drain`);
    try {
      renameSync(inbox, claimed);
    } catch (err) {
      if (!existsSync(inbox)) return [];
      throw new MessageChannelError("READ_FAILED", `无法接管收件箱 ${inbox}：${errText(err)}`);
    }

    let text: string;
    try {
      text = readFileSync(claimed, "utf8");
    } catch (err) {
      throw new MessageChannelError("READ_FAILED", `读取收件箱失败：${errText(err)}`);
    } finally {
      try {
        unlinkSync(claimed);
      } catch {
        /* the drain copy is disposable */
      }
    }

    const messages: AgentMessage[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        messages.push(coerceMessage(JSON.parse(line)));
      } catch {
        /* skip a corrupt line rather than losing the rest of the mailbox */
      }
    }
    return messages.sort((a, b) => a.sentAt - b.sentAt);
  }
}

/** Tool wiring: `msg:send` (write) and `msg:drain` (read-only per design doc §10 registry shape). */
export interface MessageToolOptions {
  /** Default sender when the call omits `from`; a function is resolved at call time. */
  agentId?: string | (() => string);
}

export function registerMessageTools(
  registry: ToolRegistry,
  channel: AgentMessageChannel,
  opts: MessageToolOptions = {},
): void {
  const resolve = (): string | undefined => (typeof opts.agentId === "function" ? opts.agentId() : opts.agentId);

  registry.register(MSG_SEND_MANIFEST, async (input) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    const from = typeof raw.from === "string" && raw.from.trim() ? raw.from.trim() : resolve();
    if (!from) return errorJson("missing_agent_id", "缺少 from（发送方），且未提供默认 agentId");
    try {
      const message = await channel.send(String(raw.to ?? ""), from, String(raw.text ?? ""));
      return JSON.stringify({ ok: true, message }, null, 2);
    } catch (err) {
      return errorJson(err instanceof MessageChannelError ? err.code : "SEND_FAILED", errText(err));
    }
  });

  registry.register(MSG_DRAIN_MANIFEST, async (input) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    const agent = typeof raw.agentId === "string" && raw.agentId.trim() ? raw.agentId.trim() : resolve();
    if (!agent) return errorJson("missing_agent_id", "缺少 agentId（收件人），且未提供默认 agentId");
    try {
      const messages = await channel.drain(agent);
      return JSON.stringify({ ok: true, agentId: agent, count: messages.length, messages }, null, 2);
    } catch (err) {
      return errorJson(err instanceof MessageChannelError ? err.code : "DRAIN_FAILED", errText(err));
    }
  });
}

export const MSG_SEND_MANIFEST: ToolManifest = {
  name: "msg:send",
  description:
    "Send a short message to another agent's inbox (file-based coordination). Free of approval — " +
    "it only appends one JSONL line under .harness/messages/.",
  permission: "write",
  readOnly: false,
  destructive: false,
  concurrentSafe: false,
  needsApproval: false,
  timeoutMs: 5_000,
  outputBudget: 2_000,
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "recipient agent id", minLength: 1 },
      from: { type: "string", description: "sender agent id (defaults to this session's id)" },
      text: { type: "string", description: "message body", minLength: 1 },
    },
    required: ["to", "text"],
  },
};

export const MSG_DRAIN_MANIFEST: ToolManifest = {
  name: "msg:drain",
  description:
    "Read and clear this agent's inbox: returns every unread message (oldest first) and empties the " +
    "mailbox. Read-only by policy — it never touches files outside .harness/messages/.",
  permission: "read",
  readOnly: true,
  destructive: false,
  concurrentSafe: true,
  needsApproval: false,
  timeoutMs: 5_000,
  outputBudget: 8_000,
  inputSchema: {
    type: "object",
    properties: {
      agentId: { type: "string", description: "inbox owner (defaults to this session's id)" },
    },
    required: [],
  },
};

function assertAgent(agentId: string): string {
  const agent = typeof agentId === "string" ? agentId.trim() : "";
  if (!AGENT_ID_RE.test(agent)) {
    throw new MessageChannelError(
      "INVALID_AGENT",
      `agent id "${agentId}" 非法：只允许字母、数字、点、下划线、连字符，长度 1–64`,
    );
  }
  return agent;
}

function coerceMessage(value: unknown): AgentMessage {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    from: typeof raw.from === "string" ? raw.from : "",
    to: typeof raw.to === "string" ? raw.to : "",
    text: typeof raw.text === "string" ? raw.text : "",
    sentAt: typeof raw.sentAt === "number" ? raw.sentAt : 0,
  };
}

function errorJson(code: string, message: string): string {
  return JSON.stringify({ ok: false, code, message }, null, 2);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
