import assert from "node:assert/strict";
import test from "node:test";

import {
  isSecretName,
  maskSecretEnvironment,
  REDACTED,
  Redactor,
  sanitizeLogText,
} from "../dist/index.js";

const redactor = Redactor.fromEnvironment({
  HF_TOKEN: "literal-secret-value",
  MAX_TOKENS: "4096",
  PATH: "/usr/bin",
});

test("redacts literal secrets and common credential shapes", () => {
  const cases = [
    ["value literal-secret-value here", "value [REDACTED] here"],
    ["Authorization: Bearer abc.def.ghi123", "Authorization: Bearer [REDACTED]"],
    [
      "curl -H 'authorization: token ghp_abcdefghijklmnopqrstuvwxyz'",
      "curl -H 'authorization: token [REDACTED]'",
    ],
    ["HF_TOKEN=hf_abcdefghijklmnopqrstuv", "HF_TOKEN=[REDACTED]"],
    ['{"api_key": "sk-abcdefghijklmnopqrstuvwx"}', '{"api_key": "[REDACTED]"}'],
    ["--api-key s3cr3tvalue --port 8888", "--api-key [REDACTED] --port 8888"],
    ["postgres://user:pa55word@db:5432/x", "postgres://[REDACTED]@db:5432/x"],
    [
      "max_tokens=4096 --max-total-tokens 655360 tokenizer=auto",
      "max_tokens=4096 --max-total-tokens 655360 tokenizer=auto",
    ],
    ["MAX_TOKENS is 4096", "MAX_TOKENS is 4096"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactor.redact(input), expected, input);
  }
});

test("ignores literal secrets shorter than 6 characters", () => {
  const short = Redactor.fromEnvironment({ API_KEY: "1" });
  assert.equal(short.redact("port 18888"), "port 18888");
  assert.equal(short.with(["extra-secret"]).redact("x extra-secret y"), `x ${REDACTED} y`);
});

test("sanitizeLogText strips control sequences and bounds length", () => {
  assert.equal(sanitizeLogText("\u001b[1;32mready\u001b[0m\u0007", redactor), "ready");
  const long = sanitizeLogText("x".repeat(10_000), redactor);
  assert.ok(long.length < 4200);
  assert.match(long, /truncated 5904 chars/);
});

test("secret names and environment masking", () => {
  for (const name of ["HF_TOKEN", "OPENAI_API_KEY", "DB_PASSWORD", "AWS_SECRET_ACCESS_KEY", "HTTP_AUTH"]) {
    assert.equal(isSecretName(name), true, name);
  }
  for (const name of ["MAX_TOKENS", "TOKENIZER", "AUTHOR", "PATH", "CONTEXT_LENGTH"]) {
    assert.equal(isSecretName(name), false, name);
  }
  assert.deepEqual(maskSecretEnvironment({ HF_TOKEN: "hf_x", CONTEXT: "65536" }), {
    HF_TOKEN: REDACTED,
    CONTEXT: "65536",
  });
});
