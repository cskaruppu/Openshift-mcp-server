/**
 * Data redaction service — strips sensitive data (secrets, tokens, passwords,
 * certificates) from API responses and LLM outputs before returning to users.
 */

const SENSITIVE_KEYS = new Set([
  "password", "secret", "token", "apikey", "api_key", "api-key",
  "authorization", "auth", "credentials", "credential",
  "private_key", "privatekey", "private-key",
  "client_secret", "clientsecret", "client-secret",
  "access_token", "accesstoken", "access-token",
  "refresh_token", "refreshtoken", "refresh-token",
  "bearer", "ssh-privatekey", "tls.key",
]);

const SENSITIVE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
  /-----BEGIN\s+CERTIFICATE-----[\s\S]*?-----END\s+CERTIFICATE-----/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g,
  /sha256:[a-f0-9]{64}/g,
];

const REDACTED = "[REDACTED]";

function isSensitiveKey(key) {
  if (!key) return false;
  const lower = key.toLowerCase().replace(/[-_]/g, "");
  for (const sk of SENSITIVE_KEYS) {
    if (lower === sk.replace(/[-_]/g, "") || lower.includes(sk.replace(/[-_]/g, ""))) {
      return true;
    }
  }
  return false;
}

export function redactObject(obj, depth = 0) {
  if (depth > 20) return obj;
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === "string") {
    return redactString(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(item => redactObject(item, depth + 1));
  }

  if (typeof obj === "object") {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (isSensitiveKey(key)) {
        if (typeof value === "string" && value.length > 0) {
          result[key] = REDACTED;
        } else if (typeof value === "object" && value !== null) {
          const redactedInner = {};
          for (const k of Object.keys(value)) {
            redactedInner[k] = REDACTED;
          }
          result[key] = redactedInner;
        } else {
          result[key] = value;
        }
      } else {
        result[key] = redactObject(value, depth + 1);
      }
    }
    return result;
  }

  return obj;
}

export function redactString(text) {
  if (typeof text !== "string") return text;
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    const fresh = new RegExp(pattern.source, pattern.flags);
    result = result.replace(fresh, REDACTED);
  }
  return result;
}

export function redactKubernetesSecret(secret) {
  if (!secret || secret.kind !== "Secret") return secret;
  const redacted = { ...secret };
  if (redacted.data) {
    const keys = Object.keys(redacted.data);
    redacted.data = {};
    for (const k of keys) {
      redacted.data[k] = REDACTED;
    }
  }
  if (redacted.stringData) {
    const keys = Object.keys(redacted.stringData);
    redacted.stringData = {};
    for (const k of keys) {
      redacted.stringData[k] = REDACTED;
    }
  }
  return redacted;
}

export function redactSecretList(list) {
  if (!list?.items) return list;
  return {
    ...list,
    items: list.items.map(item =>
      item.kind === "Secret" ? redactKubernetesSecret(item) : redactObject(item)
    ),
  };
}

export function createRedactionMiddleware() {
  return (response) => {
    if (!response) return response;
    if (typeof response === "string") return redactString(response);
    if (typeof response === "object") return redactObject(response);
    return response;
  };
}

export function isRedactionEnabled() {
  const flag = process.env.MCP_REDACTION_ENABLED;
  if (flag === undefined || flag === null) return true;
  return flag !== "false" && flag !== "0";
}

export function redactIfEnabled(data) {
  if (!isRedactionEnabled()) return data;
  if (typeof data === "string") return redactString(data);
  if (typeof data === "object") return redactObject(data);
  return data;
}
