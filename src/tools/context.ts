import type { Config } from "../config";
import type { ArchivrClient } from "../client/http";
import { ToolUserError } from "../client/errors";
import { MountedArchiveListSchema, type MeResponse } from "../client/schemas";
import { decodeRoleBits, type MinRole } from "../lib/roles";
import type { Logger } from "../lib/log";

/** The authenticated user as seen at startup (GET /api/auth/me). */
export interface Me {
  userUid: string | null;
  username: string;
  displayName: string | null;
  roleBits: number;
  /** Built-in roles decoded from `roleBits`. */
  builtinRoles: MinRole[];
  /** Role slugs from `roles[]` when the server sends them (includes custom roles); else the built-in names. */
  roles: string[];
  canReorderChildren: boolean;
}

export function decodeMe(response: MeResponse): Me {
  const builtinRoles = decodeRoleBits(response.role_bits);
  const roles = response.roles?.map((r) => (typeof r === "string" ? r : r.slug)) ?? builtinRoles;
  return {
    userUid: response.user_uid ?? null,
    username: response.username,
    displayName: response.display_name,
    roleBits: response.role_bits,
    builtinRoles,
    roles,
    canReorderChildren: response.can_reorder_children,
  };
}

/** Arguments of any archive-scoped tool: an optional explicit archive id. */
export interface ArchiveArg {
  archive?: string | undefined;
}

/** Process-wide dependencies shared by every tool call and resource read. */
export interface BaseContext {
  client: ArchivrClient;
  config: Config;
  /** `null` if GET /api/auth/me could not be completed at startup (network error). */
  me: Me | null;
  log: Logger;
  /**
   * Resolve the archive id for a call: explicit `args.archive`, else `ARCHIVR_ARCHIVE`,
   * else the only mounted archive. Throws ToolUserError (listing ids) when ambiguous.
   */
  archive(args: ArchiveArg): Promise<string>;
}

export interface ProgressUpdate {
  progress: number;
  total?: number;
  message?: string;
}

/** What a tool handler receives: the shared context plus per-call cancellation and progress. */
export interface ToolContext extends BaseContext {
  /** `client` is already bound to this signal, so aborting the MCP request cancels in-flight HTTP calls. */
  signal: AbortSignal;
  /** Send a progress notification if the caller asked for them; otherwise a no-op. */
  progress(update: ProgressUpdate): Promise<void>;
}

export function createBaseContext(params: {
  client: ArchivrClient;
  config: Config;
  me: Me | null;
  log: Logger;
}): BaseContext {
  const { client, config } = params;
  let mounted: Promise<string[]> | undefined;
  const mountedIds = (): Promise<string[]> => {
    mounted ??= client
      .request("GET", "/api/archives", { schema: MountedArchiveListSchema })
      .then((list) => list.map((a) => a.id))
      .catch((error: unknown) => {
        mounted = undefined; // do not cache failures
        throw error;
      });
    return mounted;
  };
  return {
    ...params,
    async archive(args) {
      const explicit = args.archive?.trim();
      if (explicit) return explicit;
      if (config.archive) return config.archive;
      const ids = await mountedIds();
      if (ids.length === 1 && ids[0] !== undefined) return ids[0];
      if (ids.length === 0) throw new ToolUserError("The Archivr server has no archives mounted.");
      throw new ToolUserError(
        `Several archives are mounted (${ids.join(", ")}). Pass the "archive" argument or set ARCHIVR_ARCHIVE.`,
      );
    },
  };
}

/** Bind a base context to one MCP request. */
export function toToolContext(
  base: BaseContext,
  call: { signal: AbortSignal; progress?: ToolContext["progress"] },
): ToolContext {
  return {
    ...base,
    client: base.client.withSignal(call.signal),
    signal: call.signal,
    progress: call.progress ?? (async () => {}),
  };
}
