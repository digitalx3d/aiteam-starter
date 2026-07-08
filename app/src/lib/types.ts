export type Role = "user" | "assistant" | "system";

export type ContentBlock =
  | { kind: "text"; text: string }
  | {
      kind: "tool_use";
      id: string;
      name: string;
      input: unknown;
      result?: string;
      resultIsError?: boolean;
      /** True when the tool was denied because it requires approval (Safe mode + non-edit tool). */
      needsApproval?: boolean;
      /** Tracks user choice on the approval prompt. */
      approvalStatus?: "pending" | "approved" | "denied";
    };

export interface TraceEvent {
  ts: number;
  event: unknown;
}

export interface ChatMessage {
  id: string;
  role: Role;
  blocks: ContentBlock[];
  pending?: boolean;
  traceEvents?: TraceEvent[];
  createdAt?: number;
  /** Override default role-based display name. Future: "Maya", "Devin", "PM-agent", etc. */
  personaName?: string;
}

export interface ChatState {
  sessionId: string;
  started: boolean;
  permissionMode?: "acceptEdits" | "bypassPermissions";
}
