export const REDACTED = "[REDACTED]";

const SECRET_NAME_PATTERN =
  /(?:TOKEN(?!S|IZ)|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH(?!OR)|COOKIE)/i;

const MIN_LITERAL_SECRET_LENGTH = 6;
const MAX_LINE_LENGTH = 4096;

// Credential shapes that are recognizable without knowing the variable name.
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bhf_[A-Za-z0-9]{16,}\b/g,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\x00-\x08\x0b-\x1f\x7f]/g;

export function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/**
 * Redacts credentials from text that will be stored or returned. Literal
 * values of secret-named environment variables are always removed, and common
 * credential shapes are removed even when their source is unknown.
 */
export class Redactor {
  readonly #literals: string[];

  constructor(literalSecrets: Iterable<string> = []) {
    this.#literals = [...new Set(literalSecrets)]
      .filter((value) => value.length >= MIN_LITERAL_SECRET_LENGTH)
      .sort((left, right) => right.length - left.length);
  }

  static fromEnvironment(
    ...environments: ReadonlyArray<Readonly<Record<string, string | undefined>> | undefined>
  ): Redactor {
    const literals: string[] = [];
    for (const environment of environments) {
      for (const [name, value] of Object.entries(environment ?? {})) {
        if (value && isSecretName(name)) literals.push(value);
      }
    }
    return new Redactor(literals);
  }

  with(additionalSecrets: Iterable<string>): Redactor {
    return new Redactor([...this.#literals, ...additionalSecrets]);
  }

  redact(text: string): string {
    let result = text;
    for (const literal of this.#literals) {
      if (result.includes(literal)) result = result.split(literal).join(REDACTED);
    }
    result = result
      .replace(
        /\b(authorization|proxy-authorization)(\s*[:=]\s*)(?:(bearer|basic|token)\s+)?[^\s,;"']+/gi,
        (_m, header: string, separator: string, scheme?: string) =>
          `${header}${separator}${scheme ? `${scheme} ` : ""}${REDACTED}`,
      )
      .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
      .replace(
        /(--?[A-Za-z0-9-]*(?:token(?!s|iz)|secret|password|passwd|api-key|apikey|access-key|private-key)[A-Za-z0-9-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s"']+)/gi,
        `$1$2${REDACTED}`,
      )
      .replace(
        /("?[A-Za-z0-9_.-]*(?:token(?!s|iz)|secret|password|passwd|api_?key|access_?key|private_?key|credentials?)[A-Za-z0-9_.-]*"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}"']+)/gi,
        (_m, prefix: string, value: string) =>
          value === REDACTED || value === `"${REDACTED}"`
            ? `${prefix}${value}`
            : `${prefix}${value.startsWith('"') ? `"${REDACTED}"` : REDACTED}`,
      );
    for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, REDACTED);
    return result;
  }
}

/** Removes terminal control sequences, bounds length, and redacts secrets. */
export function sanitizeLogText(text: string, redactor: Redactor): string {
  const plain = text.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
  const bounded = plain.length > MAX_LINE_LENGTH
    ? `${plain.slice(0, MAX_LINE_LENGTH)}… [truncated ${plain.length - MAX_LINE_LENGTH} chars]`
    : plain;
  return redactor.redact(bounded);
}

/** Masks values of secret-named variables in a registry environment map. */
export function maskSecretEnvironment(environment: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => [name, isSecretName(name) ? REDACTED : value]),
  );
}
