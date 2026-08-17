import { createHmac, randomBytes } from "node:crypto";

import { parseCodexUsagePayload } from "./codex-bank.js";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const AUTH_FINGERPRINT_SALT = randomBytes(32);
const MAX_SUCCESS_BODY_BYTES = 64 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;

export class CodexUsageError extends Error {
  constructor(message, code = "CODEX_USAGE_ERROR") {
    super(message);
    this.name = "CodexUsageError";
    this.code = code;
  }
}

function headerValue(headers, name) {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return typeof entry?.[1] === "string" ? entry[1] : null;
}

function authorizationFrom(auth) {
  return headerValue(auth?.headers, "Authorization") ?? (auth?.apiKey ? `Bearer ${auth.apiKey}` : null);
}

function officialCodexOrigin(value) {
  try {
    return new URL(value).origin === "https://chatgpt.com";
  } catch {
    return false;
  }
}

function sanitizeError(value, secrets = []) {
  let message = value instanceof Error ? value.message : String(value);
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((left, right) => right.length - left.length)) {
    message = message.split(secret).join("<redacted>");
  }
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

function authFingerprint(authorization, salt) {
  return createHmac("sha256", salt).update(authorization).digest("hex");
}

async function resolveCodexAuth(ctx, salt) {
  const model = ctx?.model;
  if (!model || model.provider !== "openai-codex") {
    throw new CodexUsageError("当前模型不是 OpenAI Codex 订阅模型", "CODEX_NOT_CURRENT_PROVIDER");
  }
  if (!officialCodexOrigin(model.baseUrl)) {
    throw new CodexUsageError(
      "当前 Codex 模型使用自定义或代理 origin；为避免泄露凭据，拒绝查询官方 usage endpoint",
      "CODEX_UNSAFE_MODEL_ORIGIN",
    );
  }

  const registry = ctx.modelRegistry;
  if (!registry || typeof registry.getProviderAuth !== "function") {
    throw new CodexUsageError("当前 Pi 版本不能解析 provider runtime auth", "CODEX_AUTH_API_UNAVAILABLE");
  }

  let modelAuth = null;
  if (typeof registry.getApiKeyAndHeaders === "function") {
    const result = await registry.getApiKeyAndHeaders(model);
    if (!result?.ok) {
      throw new CodexUsageError(sanitizeError(result?.error ?? "Codex runtime auth 不可用"), "CODEX_AUTH_UNAVAILABLE");
    }
    if (authorizationFrom(result)) modelAuth = result;
  }

  const providerResult = await registry.getProviderAuth("openai-codex");
  const providerAuth = providerResult?.auth ?? null;
  if (providerAuth?.baseUrl && !officialCodexOrigin(providerAuth.baseUrl)) {
    throw new CodexUsageError(
      "Pi 解析到代理 provider origin；为避免把凭据发送到错误账户端点，已拒绝查询",
      "CODEX_UNSAFE_AUTH_ORIGIN",
    );
  }

  const auth = modelAuth ?? providerAuth;
  const authorization = authorizationFrom(auth);
  if (!authorization) {
    throw new CodexUsageError("当前 Pi Codex 账户没有可用的运行时 OAuth 授权", "CODEX_AUTH_UNAVAILABLE");
  }
  const secrets = [authorization, auth?.apiKey, headerValue(auth?.headers, "Authorization")].filter(Boolean);
  return {
    authorization,
    fingerprint: authFingerprint(authorization, salt),
    secrets,
  };
}

async function readBoundedResponse(response, maxBytes, truncateOverflow, description) {
  if (!response.body?.getReader) {
    const text = await response.text();
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength <= maxBytes) return text;
    if (!truncateOverflow) throw new CodexUsageError(`${description} 超过 ${maxBytes} bytes`, "CODEX_USAGE_RESPONSE_TOO_LARGE");
    return new TextDecoder().decode(bytes.subarray(0, maxBytes));
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (truncated && !truncateOverflow) {
    throw new CodexUsageError(`${description} 超过 ${maxBytes} bytes`, "CODEX_USAGE_RESPONSE_TOO_LARGE");
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export function isCodexUsageAbortError(error) {
  return error?.name === "AbortError" || error?.code === "CODEX_USAGE_ABORTED";
}

export async function queryCodexSubscriptionUsage(
  ctx,
  {
    signal,
    timeoutMs = 12_000,
    fetchImpl = globalThis.fetch,
    salt = AUTH_FINGERPRINT_SALT,
  } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new CodexUsageError("当前 Node 运行时没有 fetch", "CODEX_FETCH_UNAVAILABLE");
  }
  const auth = await resolveCodexAuth(ctx, salt);
  const callerSignal = signal ?? new AbortController().signal;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (callerSignal.aborted) controller.abort();
  else callerSignal.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetchImpl(CODEX_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: auth.authorization,
        "User-Agent": "pi-idea-harness",
      },
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      throw Object.assign(new CodexUsageError("Codex usage 查询已取消", "CODEX_USAGE_ABORTED"), { name: "AbortError" });
    }
    const text = await readBoundedResponse(
      response,
      response.ok ? MAX_SUCCESS_BODY_BYTES : MAX_ERROR_BODY_BYTES,
      !response.ok,
      "Codex usage 响应",
    );
    if (!response.ok) {
      throw new CodexUsageError(
        `Codex usage endpoint 返回 ${response.status} ${response.statusText}: ${sanitizeError(text, auth.secrets)}`,
        "CODEX_USAGE_HTTP_ERROR",
      );
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new CodexUsageError(`Codex usage endpoint 返回无效 JSON：${sanitizeError(error)}`, "CODEX_USAGE_INVALID_JSON");
    }
    return {
      bank: parseCodexUsagePayload(payload, new Date().toISOString()),
      fingerprint: auth.fingerprint,
    };
  } catch (error) {
    if (timedOut) {
      throw new CodexUsageError(`Codex usage 查询在 ${Math.round(timeoutMs / 1_000)} 秒后超时`, "CODEX_USAGE_TIMEOUT");
    }
    if (callerSignal.aborted || isCodexUsageAbortError(error)) {
      throw Object.assign(new CodexUsageError("Codex usage 查询已取消", "CODEX_USAGE_ABORTED"), { name: "AbortError" });
    }
    if (error instanceof CodexUsageError) throw error;
    throw new CodexUsageError(sanitizeError(error, auth.secrets), "CODEX_USAGE_NETWORK_ERROR");
  } finally {
    clearTimeout(timeout);
    callerSignal.removeEventListener("abort", abortFromCaller);
  }
}
