/**
 * One place that writes a failed RPC call to the server log. The message, the
 * code and the hint are logged: details are skipped because PostgreSQL can put
 * row values there. Never log the payload, the session, keys, cookies, text
 * content or image data. The prefix names the call, for example
 * [review_decision].
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
    hint: error.hint ?? null,
  });
}
