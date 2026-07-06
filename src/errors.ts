/**
 * Shared error response builders.
 *
 * Canonical signatures:
 *   anthropicError(status, type, message) -> {type:"error", error:{type, message}}
 *   openAIError(status, type, message)    -> {error:{message, type, param:null, code:null}}
 */

export function anthropicError(
  status: number,
  type: string,
  message: string
): Response {
  return Response.json(
    { type: "error", error: { type, message } },
    { status }
  );
}

export function openAIError(
  status: number,
  type: string,
  message: string
): Response {
  return Response.json(
    { error: { message, type, param: null, code: null } },
    { status }
  );
}
