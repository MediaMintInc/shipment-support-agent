import { Agent, type Model } from '@strands-agents/sdk';
import { z } from 'zod';
import { finalText } from '../agent/agent.js';
import type { CaseTrace } from './trace.js';
import { toolResultText } from './trace.js';

/**
 * Optional rubric-based LLM judge. It only produces a quality score for aspects that
 * deterministic checks cannot assess (clarity, tone, helpfulness). It never decides pass/fail.
 */
export const DEFAULT_RUBRIC = `Score the assistant's final reply from 1 (poor) to 5 (excellent) on:
- Helpfulness: answers what the user asked, or asks for exactly the missing information.
- Clarity and concision: easy to read, no filler.
- Honesty: communicates failures and uncertainty plainly, without speculation.
Do not judge factual accuracy against the world; tool results are the ground truth provided.`;

export interface JudgeResult {
  score: number;
  maxScore: 5;
  rationale: string;
}

const JudgeSchema = z.object({ score: z.number().int().min(1).max(5), rationale: z.string() });

export async function judgeCase(model: Model, trace: CaseTrace, rubric: string | undefined): Promise<JudgeResult> {
  const transcript = trace.turns
    .map((t) => {
      const tools = t.mcpCalls
        .map((c) => `  tool ${c.tool}(${JSON.stringify(c.arguments)}) -> ${toolResultText(c).slice(0, 800)}`)
        .join('\n');
      return `USER: ${t.user}\n${tools ? `TOOL CALLS:\n${tools}\n` : ''}ASSISTANT: ${t.response}`;
    })
    .join('\n\n');

  const judge = new Agent({
    model,
    printer: false,
    systemPrompt:
      'You are a strict evaluator of a customer-support assistant. Respond with ONLY a JSON object ' +
      '{"score": <integer 1-5>, "rationale": "<one or two sentences>"}. No other text.',
  });
  const res = await judge.invoke(`RUBRIC:\n${rubric ?? DEFAULT_RUBRIC}\n\nTRANSCRIPT:\n${transcript}`);
  const text = finalText(res);
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  const parsed = JudgeSchema.safeParse(json ? JSON.parse(json) : null);
  if (!parsed.success) throw new Error(`Judge returned unparseable output: ${text.slice(0, 200)}`);
  return { score: parsed.data.score, maxScore: 5, rationale: parsed.data.rationale };
}
