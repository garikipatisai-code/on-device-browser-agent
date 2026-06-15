// Tool registry. Zod-validated dispatch.
// Tools are self-describing: schema produces JSON Schema for Ollama's `tools` array.

import { z } from 'zod';
import type { OllamaClient, ToolDef } from '@/background/ollama';
import type { Settings, TimelineEvent } from '@/shared/messages';
import type { AgentStateHot } from '@/background/state_store';

export interface ToolContext {
  taskId: string;
  signal: AbortSignal;
  hot: AgentStateHot;
  settings: Settings;
  ollama: OllamaClient;
  emit(event: TimelineEvent): void;
  addFinding(kind: string, data: unknown, stepId?: string): Promise<void>;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  data?: Record<string, unknown>;
  fatal?: boolean;
  unknownTool?: boolean;
  /** When true, the orchestrator advances the plan step. */
  advanceStep?: boolean;
  /** When true, the orchestrator finishes the task with the carried verdict/summary. */
  finish?: { verdict: string; summary: string };
}

export interface ToolDefDescriptor<A> {
  name: string;
  description: string;
  argsSchema: z.ZodType<A>;
  dispatch(args: A, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private defs = new Map<string, ToolDefDescriptor<unknown>>();

  register<A>(def: ToolDefDescriptor<A>): void {
    this.defs.set(def.name, def as unknown as ToolDefDescriptor<unknown>);
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }

  list(): string[] {
    return [...this.defs.keys()].sort();
  }

  toolDefs(filter?: (name: string) => boolean): ToolDef[] {
    const out: ToolDef[] = [];
    for (const def of this.defs.values()) {
      if (filter && !filter(def.name)) continue;
      out.push({
        type: 'function',
        function: {
          name: def.name,
          description: def.description,
          parameters: zodToJsonSchema(def.argsSchema),
        },
      });
    }
    return out;
  }

  async dispatch(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const def = this.defs.get(name);
    if (!def) {
      return {
        ok: false,
        content: `Unknown tool: ${name}. Available: ${this.list().join(', ')}`,
        unknownTool: true,
      };
    }
    const parsed = def.argsSchema.safeParse(args);
    if (!parsed.success) {
      return {
        ok: false,
        content: `Invalid arguments for ${name}: ${parsed.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join('; ')}`,
      };
    }
    try {
      return await def.dispatch(parsed.data, ctx);
    } catch (err) {
      const e = err as { message?: string; fatal?: boolean };
      return {
        ok: false,
        content: `Tool ${name} threw: ${e.message ?? String(err)}`,
        fatal: !!e.fatal,
      };
    }
  }

  describe(): string {
    const lines: string[] = [];
    for (const def of this.defs.values()) {
      lines.push(`- ${def.name}: ${def.description}`);
    }
    return lines.join('\n');
  }
}

// Minimal Zod → JSON Schema (we control the input shape).
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return zodNode(schema);
}

function zodNode(s: z.ZodTypeAny): Record<string, unknown> {
  if (s instanceof z.ZodString) {
    const out: Record<string, unknown> = { type: 'string' };
    if (s.description) out.description = s.description;
    return out;
  }
  if (s instanceof z.ZodNumber) return desc(s, { type: 'number' });
  if (s instanceof z.ZodBoolean) return desc(s, { type: 'boolean' });
  if (s instanceof z.ZodOptional) {
    return zodNode(s.unwrap());
  }
  if (s instanceof z.ZodNullable) {
    const inner = zodNode(s.unwrap());
    const t = inner.type;
    if (Array.isArray(t)) return { ...inner, type: [...t, 'null'] };
    return { ...inner, type: t === undefined ? 'null' : [t, 'null'] };
  }
  if (s instanceof z.ZodArray) {
    return desc(s, { type: 'array', items: zodNode(s.element) });
  }
  if (s instanceof z.ZodEnum) {
    return desc(s, { type: 'string', enum: [...s.options] });
  }
  if (s instanceof z.ZodLiteral) {
    const v = s.value;
    return desc(s, { type: typeof v, const: v });
  }
  if (s instanceof z.ZodObject) {
    const shape = s.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = zodNode(v);
      if (!(v instanceof z.ZodOptional || v instanceof z.ZodDefault)) {
        required.push(k);
      }
    }
    const out: Record<string, unknown> = { type: 'object', properties, additionalProperties: false };
    if (required.length) out.required = required;
    if (s.description) out.description = s.description;
    return out;
  }
  if (s instanceof z.ZodDefault) {
    const inner = zodNode(s._def.innerType as z.ZodTypeAny);
    return { ...inner, default: s._def.defaultValue() };
  }
  if (s instanceof z.ZodUnion) {
    const opts = s.options as z.ZodTypeAny[];
    return { anyOf: opts.map(zodNode) };
  }
  return { type: 'string' };
}

function desc(s: z.ZodTypeAny, base: Record<string, unknown>): Record<string, unknown> {
  if (s.description) return { ...base, description: s.description };
  return base;
}
