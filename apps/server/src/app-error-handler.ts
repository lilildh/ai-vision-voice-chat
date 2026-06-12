type ExpressBodyParserError = {
  status: 400 | 413;
  type: string;
};

const malformedJsonErrorTypes = new Set([
  "entity.parse.failed",
  "entity.too.large"
]);

export function isMalformedJsonRequestError(
  error: unknown
): error is ExpressBodyParserError {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as {
    status?: unknown;
    type?: unknown;
  };

  return (
    typeof candidate.type === "string" &&
    malformedJsonErrorTypes.has(candidate.type) &&
    (candidate.status === 400 || candidate.status === 413)
  );
}
