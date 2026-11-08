import type { Model } from '@strands-agents/sdk';
import type { OpenAIModelOptions } from '@strands-agents/sdk/models/openai';
import type { AgentEnv } from '../config/env.js';

export const DEFAULT_MODEL_IDS: Record<AgentEnv['MODEL_PROVIDER'], string> = {
  bedrock: 'global.anthropic.claude-sonnet-4-6',
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-5.4',
};

export interface ModelInfo {
  provider: AgentEnv['MODEL_PROVIDER'];
  modelId: string;
}

/** Hosts the configured provider talks to; used by the eval network guard. */
export function providerHosts(env: AgentEnv): string[] {
  switch (env.MODEL_PROVIDER) {
    case 'anthropic':
      return ['api.anthropic.com'];
    case 'openai':
      return [env.OPENAI_BASE_URL ? new URL(env.OPENAI_BASE_URL).hostname : 'api.openai.com'];
    case 'bedrock': {
      const region = env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-west-2';
      return [`bedrock-runtime.${region}.amazonaws.com`, `sts.${region}.amazonaws.com`, 'sts.amazonaws.com', 'portal.sso.' + region + '.amazonaws.com'];
    }
  }
}

/** Fails fast with an actionable message when credentials for the provider are missing. */
export function assertCredentials(env: AgentEnv): void {
  if (env.MODEL_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    throw new Error('MODEL_PROVIDER=anthropic requires ANTHROPIC_API_KEY.');
  }
  if (env.MODEL_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
    throw new Error('MODEL_PROVIDER=openai requires OPENAI_API_KEY.');
  }
  // Bedrock uses the standard AWS credential chain (env vars, profile, SSO); checked on first call.
}

/**
 * OpenAI options. Uses the Responses API by default (stateless: the agent keeps history, so
 * each eval case starts clean). Temperature is only sent when configured, because GPT-5-family
 * reasoning models reject non-default values.
 */
export function openAIModelOptions(env: AgentEnv, modelId: string): OpenAIModelOptions {
  const common = {
    modelId,
    maxTokens: env.MODEL_MAX_TOKENS,
    ...(env.MODEL_TEMPERATURE !== undefined ? { temperature: env.MODEL_TEMPERATURE } : {}),
    ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {}),
    ...(env.OPENAI_BASE_URL || env.OPENAI_ORG_ID
      ? {
          clientConfig: {
            ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
            ...(env.OPENAI_ORG_ID ? { organization: env.OPENAI_ORG_ID } : {}),
          },
        }
      : {}),
  };
  const effort = env.OPENAI_REASONING_EFFORT;
  if (env.OPENAI_API_MODE === 'chat') {
    return { api: 'chat', ...common, ...(effort ? { params: { reasoning_effort: effort } } : {}) };
  }
  return { api: 'responses', stateful: false, ...common, ...(effort ? { params: { reasoning: { effort } } } : {}) };
}

/** Builds the Strands model provider from environment configuration. */
export async function createModel(env: AgentEnv): Promise<{ model: Model; info: ModelInfo }> {
  const modelId = env.MODEL_ID ?? DEFAULT_MODEL_IDS[env.MODEL_PROVIDER];
  const info: ModelInfo = { provider: env.MODEL_PROVIDER, modelId };
  switch (env.MODEL_PROVIDER) {
    case 'bedrock': {
      const { BedrockModel } = await import('@strands-agents/sdk/models/bedrock');
      return {
        model: new BedrockModel({
          modelId,
          ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
          temperature: env.MODEL_TEMPERATURE,
          maxTokens: env.MODEL_MAX_TOKENS,
        }),
        info,
      };
    }
    case 'anthropic': {
      const { AnthropicModel } = await import('@strands-agents/sdk/models/anthropic');
      return {
        model: new AnthropicModel({
          modelId,
          ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
          temperature: env.MODEL_TEMPERATURE,
          maxTokens: env.MODEL_MAX_TOKENS,
        }),
        info,
      };
    }
    case 'openai': {
      const { OpenAIModel } = await import('@strands-agents/sdk/models/openai');
      return { model: new OpenAIModel(openAIModelOptions(env, modelId)), info };
    }
  }
}
