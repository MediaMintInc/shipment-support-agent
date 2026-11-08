import { Model, type Message, type ModelStreamEvent } from '@strands-agents/sdk';

/**
 * DETERMINISTIC TEST DOUBLE — NOT AN LLM.
 *
 * A scripted model used to exercise orchestration (Strands agent loop → MCP client → real MCP
 * servers → adapters → mock backend) without credentials. Results obtained with it say nothing
 * about real LLM behaviour; they only prove the plumbing and the evaluation harness work.
 */

export interface ScriptView {
  /** User messages so far. */
  userMessages: string[];
  /** Parsed JSON payloads of tool results in the most recent message (if any). */
  lastToolResults: Array<Record<string, unknown> | null>;
  /** Number of model calls made in the current agent invocation chain. */
  step: number;
}

export type ScriptStep =
  | { tool: string; input: Record<string, unknown> }
  | { text: string };

export type Script = (view: ScriptView) => ScriptStep;

let idCounter = 0;

export class ScriptedModel extends Model<{ modelId?: string }> {
  private config: { modelId?: string } = { modelId: 'scripted-model' };
  private step = 0;

  constructor(private readonly script: Script) {
    super();
  }

  updateConfig(c: { modelId?: string }): void {
    this.config = { ...this.config, ...c };
  }

  getConfig(): { modelId?: string } {
    return this.config;
  }

  async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const view = this.view(messages);
    const next = this.script(view);
    this.step++;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if ('tool' in next) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: next.tool, toolUseId: `tooluse_${++idCounter}` } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(next.input) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    } else {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: next.text } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
    yield { type: 'modelMetadataEvent', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }

  private view(messages: Message[]): ScriptView {
    const userMessages: string[] = [];
    for (const m of messages) {
      if (m.role !== 'user') continue;
      const text = m.content
        .map((b) => (b.type === 'textBlock' ? (b as unknown as { text: string }).text : ''))
        .join('')
        .trim();
      if (text) userMessages.push(text);
    }
    const last = messages.at(-1);
    const lastToolResults: Array<Record<string, unknown> | null> = [];
    if (last) {
      for (const b of last.content) {
        if (b.type !== 'toolResultBlock') continue;
        const content = (b as unknown as { content: Array<{ type: string; text?: string }> }).content;
        const text = content.find((c) => c.type === 'textBlock')?.text;
        try {
          lastToolResults.push(text ? (JSON.parse(text) as Record<string, unknown>) : null);
        } catch {
          lastToolResults.push({ _text: text });
        }
      }
    }
    return { userMessages, lastToolResults, step: this.step };
  }
}

/** Convenience: run a fixed sequence of steps, then fall back to a final text. */
export function sequence(steps: ScriptStep[], final: (v: ScriptView) => string): Script {
  let i = 0;
  return (v) => (i < steps.length ? steps[i++]! : { text: final(v) });
}
