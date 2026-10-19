/**
 * One place that writes a failed RPC call to the server log. Only the four
 * Postgres error fields are logged: never the payload, the session, keys or
 * cookies. The prefix names the call, for example [claim_conversation].
 */

export type RpcErrorFields = {
  message: string;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
};

export function logRpcError(prefix: string, error: RpcErrorFields): void {
  console.error(prefix, {
    message: error.message,
    code: error.code ?? null,
    details: error.details ?? null,
    hint: error.hint ?? null,
  });
}
