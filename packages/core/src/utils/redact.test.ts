import { describe, expect, it } from "vitest";
import { scrubSensitiveText } from "./redact";

describe("scrubSensitiveText", () => {
  it("redacts Windows paths containing spaces", () => {
    expect(
      scrubSensitiveText("Failed to open C:\\Users\\Jane Doe\\Private Book.pdf: ENOENT"),
    ).toBe("Failed to open <path>: ENOENT");
  });

  it("redacts POSIX paths containing spaces", () => {
    expect(scrubSensitiveText("ENOENT: /home/jane doe/Books/Private Book.epub")).toBe(
      "ENOENT: <path>",
    );
  });

  it("redacts URLs, including userinfo", () => {
    expect(scrubSensitiveText("fetch https://user:pass@example.com/private?q=1 failed")).toBe(
      "fetch <url> failed",
    );
    expect(scrubSensitiveText("asset://localhost/books/secret.pdf")).toBe("<url>");
  });

  it("redacts common credentials", () => {
    expect(scrubSensitiveText("token ghp_abcdefghijklmnopqrstuvwxyz")).toBe(
      "token <redacted>",
    );
    expect(scrubSensitiveText("Authorization: Bearer abc.def.ghi")).toBe(
      "Authorization: Bearer <redacted>",
    );
    expect(
      scrubSensitiveText(
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ),
    ).toBe("jwt <redacted>");
  });

  it("keeps book ids and other locators intact", () => {
    const bookId = "550e8400-e29b-41d4-a716-446655440000";
    expect(scrubSensitiveText(`bookId=${bookId}`)).toBe(`bookId=${bookId}`);
    expect(scrubSensitiveText("bookId=4f9c2a1e8b7d")).toBe("bookId=4f9c2a1e8b7d");
  });
});
