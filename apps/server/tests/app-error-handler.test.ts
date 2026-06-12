import { describe, expect, it } from "vitest";

import { isMalformedJsonRequestError } from "../src/app-error-handler";

describe("app error classification", () => {
  it("classifies body parser JSON and body-size errors as malformed JSON", () => {
    const parseError = Object.assign(new SyntaxError("Unexpected token"), {
      status: 400,
      type: "entity.parse.failed"
    });
    const tooLargeError = Object.assign(new Error("request entity too large"), {
      status: 413,
      type: "entity.too.large"
    });

    expect(isMalformedJsonRequestError(parseError)).toBe(true);
    expect(isMalformedJsonRequestError(tooLargeError)).toBe(true);
  });

  it("does not classify ordinary route failures as malformed JSON", () => {
    const providerError = Object.assign(new Error("provider failed"), {
      status: 500
    });

    expect(isMalformedJsonRequestError(providerError)).toBe(false);
  });
});
