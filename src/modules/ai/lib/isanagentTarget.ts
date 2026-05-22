import {
  getModel,
  LMSTUDIO_DEFAULT_BASE_URL,
  MLX_DEFAULT_BASE_URL,
  providerNeedsKey,
  type ModelId,
} from "../config";
import type { ProviderKeys } from "./keyring";

export type IsanAgentTarget = {
  providerName: string;
  apiKey: string;
  modelName: string;
  baseUrl: string;
};

export type IsanAgentTargetResolution =
  | { ok: true; target: IsanAgentTarget }
  | { ok: false; error: string };

export type IsanAgentPrefsView = {
  lmstudioBaseURL?: string;
  lmstudioModelId?: string;
  mlxBaseURL?: string;
  mlxModelId?: string;
  openaiCompatibleBaseURL?: string;
};

// IsanAgent's OpenAI-compat client treats the base URL as the FULL endpoint
// (i.e. it POSTs to base_url as-is — no `/chat/completions` appended).
// The Anthropic provider treats base_url the same way. So we hand it
// fully-qualified endpoint URLs per provider.
export function resolveIsanAgentTarget(
  modelId: ModelId,
  apiKeys: ProviderKeys,
  prefs: IsanAgentPrefsView,
): IsanAgentTargetResolution {
  const model = getModel(modelId);
  const provider = model.provider;
  let modelName = model.id;

  if (model.id === "lmstudio-local") {
    const id = prefs.lmstudioModelId?.trim();
    if (!id) {
      return {
        ok: false,
        error:
          "LM Studio: no model id set. Open Settings → Models and enter the model id served by lms.",
      };
    }
    modelName = id;
  } else if (model.id === "mlx-local") {
    const id = prefs.mlxModelId?.trim();
    if (!id) {
      return {
        ok: false,
        error:
          "MLX: no model id set. Open Settings → Models and enter the model id served by mlx_lm.server.",
      };
    }
    modelName = id;
  }

  if (providerNeedsKey(provider) && !apiKeys[provider]) {
    return {
      ok: false,
      error: `No API key configured for ${provider}. Open Settings → Models to add one.`,
    };
  }
  const apiKey = apiKeys[provider] ?? "";

  switch (provider) {
    case "anthropic":
      return ok({
        providerName: "anthropic",
        apiKey,
        modelName,
        baseUrl: "https://api.anthropic.com/v1/messages",
      });
    case "openai":
      return ok({
        providerName: "openai",
        apiKey,
        modelName,
        baseUrl: "https://api.openai.com/v1/chat/completions",
      });
    case "google":
      // Gemini's OpenAI-compatible endpoint.
      return ok({
        providerName: "google",
        apiKey,
        modelName,
        baseUrl:
          "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      });
    case "xai":
      return ok({
        providerName: "xai",
        apiKey,
        modelName,
        baseUrl: "https://api.x.ai/v1/chat/completions",
      });
    case "cerebras":
      return ok({
        providerName: "cerebras",
        apiKey,
        modelName,
        baseUrl: "https://api.cerebras.ai/v1/chat/completions",
      });
    case "groq":
      return ok({
        providerName: "groq",
        apiKey,
        modelName,
        baseUrl: "https://api.groq.com/openai/v1/chat/completions",
      });
    case "deepseek":
      return ok({
        providerName: "deepseek",
        apiKey,
        modelName,
        baseUrl: "https://api.deepseek.com/v1/chat/completions",
      });
    case "mistral":
      return ok({
        providerName: "mistral",
        apiKey,
        modelName,
        baseUrl: "https://api.mistral.ai/v1/chat/completions",
      });
    case "openrouter":
      return ok({
        providerName: "openrouter",
        apiKey,
        modelName,
        baseUrl: "https://openrouter.ai/api/v1/chat/completions",
      });
    case "openai-compatible": {
      const base = prefs.openaiCompatibleBaseURL?.trim();
      if (!base) {
        return {
          ok: false,
          error:
            "OpenAI-compatible: base URL not set. Open Settings → Models.",
        };
      }
      return ok({
        providerName: "openai-compatible",
        apiKey,
        modelName,
        baseUrl: ensureChatCompletions(base),
      });
    }
    case "lmstudio":
      return ok({
        providerName: "lmstudio",
        apiKey: "",
        modelName,
        baseUrl: ensureChatCompletions(
          prefs.lmstudioBaseURL?.trim() || LMSTUDIO_DEFAULT_BASE_URL,
        ),
      });
    case "mlx":
      return ok({
        providerName: "mlx",
        apiKey: "",
        modelName,
        baseUrl: ensureChatCompletions(
          prefs.mlxBaseURL?.trim() || MLX_DEFAULT_BASE_URL,
        ),
      });
    default: {
      const _exhaustive: never = provider;
      return {
        ok: false,
        error: `Unsupported provider: ${_exhaustive as string}`,
      };
    }
  }
}

function ok(target: IsanAgentTarget): IsanAgentTargetResolution {
  return { ok: true, target };
}

function ensureChatCompletions(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  if (/\/(chat\/)?completions$/.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}
