#!/usr/bin/env node
// Tool-call reliability harness for a local Ollama model.
//
// Measures the blueprint's #1 risk (06/08): can the Executor model emit a
// VALID tool_call on the first try? Mirrors how src/background/ollama.ts +
// src/agent/roles/executor.ts build the request — same /api/chat shape, same
// tool schemas, same executor-style prompt — so the numbers reflect reality.
//
//   Usage:
//     node scripts/measure_toolcalls.mjs                 # gemma4:e4b, 5 trials each
//     node scripts/measure_toolcalls.mjs gemma4:12b 8    # model, trials
//
// Requires: `ollama serve` running locally. No npm deps. Uses node:http
// directly (NOT fetch) so a corporate HTTP(S)_PROXY env var can't hijack the
// localhost connection.

import http from 'node:http';

const MODEL = process.argv[2] || 'gemma4:e4b';
const TRIALS = Number.parseInt(process.argv[3] || '5', 10);
// Default 6000 keeps the historical e4b baseline comparable. Set
// OLLAMA_NUM_CTX=32000 to measure latency/VRAM at the app's real window
// (NUM_CTX in src/agent/budget.ts) — for a 26B MoE this is where VRAM spill,
// not tool-call reliability, decides whether it's "fast enough for our app".
const NUM_CTX = Number.parseInt(process.env.OLLAMA_NUM_CTX || '6000', 10);
const BASE = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const BASE_URL = new URL(BASE);

// Direct localhost POST/GET via node:http — bypasses any proxy.
function httpJson(method, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = http.request(
      {
        host: BASE_URL.hostname,
        port: BASE_URL.port || 80,
        path,
        method,
        headers: {
          'content-type': 'application/json',
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        },
        // never route through a proxy agent
        agent: false,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`bad JSON: ${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---- representative subset of the real tool registry (JSON Schema) ----
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'tab.open',
      description: 'Open a new tab at the given URL. Registers ownership so the agent may close it later.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Absolute URL.' } },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'aria.extract',
      description:
        'Extract the simplified ARIA accessibility tree for a tab. Returns the indexed tree text for the model to read and interact with.',
      parameters: {
        type: 'object',
        properties: { tabId: { type: 'number' } },
        required: ['tabId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tab.type',
      description:
        'Type text into a field by ARIA tree index. Pass clear=true to wipe existing content first. Requires click-only tier.',
      parameters: {
        type: 'object',
        properties: {
          tabId: { type: 'number' },
          elementIndex: { type: 'number' },
          text: { type: 'string' },
          clear: { type: 'boolean' },
        },
        required: ['tabId', 'elementIndex', 'text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tab.click',
      description: 'Click an interactive element by its ARIA tree index. Requires click-only tier or higher.',
      parameters: {
        type: 'object',
        properties: { tabId: { type: 'number' }, elementIndex: { type: 'number' } },
        required: ['tabId', 'elementIndex'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description: 'Web search via DuckDuckGo. Returns title, url, and snippet for each result.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, max: { type: 'number' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'product.extract',
      description:
        'Extract products (title, price, rating, URL) from the current tab. Uses retailer-specific adapters when available.',
      parameters: {
        type: 'object',
        properties: { tabId: { type: 'number' } },
        required: ['tabId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'next_step',
      description: 'Mark the current plan step as done and advance to the next.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'End the task. Use when the goal is achieved, impossible, or a blocker requires human help.',
      parameters: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['success', 'partial', 'blocked', 'failed'] },
          summary: { type: 'string' },
        },
        required: ['verdict', 'summary'],
        additionalProperties: false,
      },
    },
  },
];
const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));

const SYSTEM = `You are the EXECUTOR in a browser agent.

Your job: Execute the CURRENT step. Read pages, interact with them, and report results. Call ONE tool per turn. Be decisive.

Rules:
- Read before you act: use aria.extract before clicking.
- Use element indices from the most recent aria.extract output (e.g. "click element [3]").
- If you produce text instead of a tool call, you will be re-prompted; do not chat.
- Don't plan ahead. Stay on the current step.`;

// ---- scenarios: realistic executor situations with an expected tool ----
const SCENARIOS = [
  {
    name: 'open-site',
    expect: ['tab.open'],
    user: `GOAL: Find a wireless mouse under $30 on Amazon

PLAN:
  ▶ 1. Navigate to amazon.com  [criteria: amazon.com is open in a tab]

OPEN TABS: (none)

Do the current step.`,
  },
  {
    name: 'read-page',
    expect: ['aria.extract'],
    user: `GOAL: Find a wireless mouse under $30 on Amazon

PLAN:
  ▶ 1. Read the Amazon homepage to find the search box  [criteria: ARIA tree extracted]

OPEN TABS: 5 (https://amazon.com)

Do the current step.`,
  },
  {
    name: 'type-query',
    expect: ['tab.type'],
    user: `GOAL: Find a wireless mouse under $30 on Amazon

PLAN:
  ▶ 1. Type "wireless mouse" into the search box  [criteria: query entered]

OPEN TABS: 5 (https://amazon.com)

<untrusted_page_content kind="aria_tree">
[1] link "Skip to main content"
[2] searchbox "Search Amazon"
[3] button "Go"
</untrusted_page_content>

Do the current step.`,
  },
  {
    name: 'click-button',
    expect: ['tab.click'],
    user: `GOAL: Find a wireless mouse under $30 on Amazon

PLAN:
  ▶ 1. Click the search button to submit the query  [criteria: results page loads]

OPEN TABS: 5 (https://amazon.com)

RECENT ACTIONS:
- ✓ tab.type({"tabId":5,"elementIndex":2,"text":"wireless mouse"}) → Typed 14 chars

<untrusted_page_content kind="aria_tree">
[1] link "Skip to main content"
[2] searchbox "Search Amazon" ="wireless mouse"
[3] button "Go"
</untrusted_page_content>

Do the current step.`,
  },
  {
    name: 'finish',
    expect: ['finish', 'next_step'],
    user: `GOAL: Find a wireless mouse under $30 on Amazon

PLAN:
  ▶ 3. Report the top results under $30  [criteria: user told the top picks]

FINDINGS:
- Logitech M330 — $19.99
- Amazon Basics Wireless Mouse — $12.99
- Razer DeathAdder Essential — $29.99

Do the current step.`,
  },
];

async function chatOnce(messages, toolChoice) {
  const body = {
    model: MODEL,
    messages,
    stream: false,
    keep_alive: '10m',
    tools: TOOLS,
    tool_choice: toolChoice,
    think: false,
    // Gemma 4's official sampling (model card): temp 1.0, top_p 0.95, top_k 64.
    options: { temperature: 1.0, top_p: 0.95, top_k: 64, num_ctx: NUM_CTX, cache_prompt: true },
  };
  const t0 = Date.now();
  const json = await httpJson('POST', '/api/chat', body);
  const ms = Date.now() - t0;
  const calls = json?.message?.tool_calls ?? [];
  const first = calls[0]?.function;
  return { ms, name: first?.name, argsRaw: first?.arguments, text: json?.message?.content ?? '' };
}

function argsOk(name, argsRaw) {
  let args = argsRaw;
  if (typeof argsRaw === 'string') {
    try {
      args = JSON.parse(argsRaw);
    } catch {
      return false;
    }
  }
  if (!args || typeof args !== 'object') return false;
  const def = TOOLS.find((t) => t.function.name === name);
  if (!def) return false;
  return (def.function.parameters.required ?? []).every((k) => k in args);
}

async function main() {
  // preflight
  try {
    const tags = await httpJson('GET', '/api/tags');
    const have = (tags.models ?? []).map((m) => m.name);
    if (!have.some((n) => n === MODEL || n === `${MODEL}:latest` || n.replace(/:latest$/, '') === MODEL)) {
      console.error(`Model "${MODEL}" not found. Installed: ${have.join(', ') || '(none)'}`);
      console.error(`Pull it:  ollama pull ${MODEL}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`Cannot reach Ollama at ${BASE}. Is "ollama serve" running?`);
    console.error(`  ${e.message}`);
    process.exit(1);
  }

  console.log(`\nTool-call reliability — model=${MODEL}, trials/scenario=${TRIALS}, num_ctx=${NUM_CTX}, base=${BASE}\n`);

  let totalFirstTry = 0;
  let totalCorrect = 0;
  let totalArgsOk = 0;
  let totalRecovered = 0; // recovered on nudge retry after empty first try
  let totalCalls = 0;
  const latencies = [];

  for (const sc of SCENARIOS) {
    let firstTry = 0;
    let correct = 0;
    let argsValid = 0;
    let recovered = 0;
    for (let i = 0; i < TRIALS; i++) {
      totalCalls++;
      const messages = [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: sc.user },
      ];
      let r;
      try {
        r = await chatOnce(messages, 'auto');
      } catch (e) {
        console.error(`  ${sc.name} trial ${i}: ERROR ${e.message}`);
        continue;
      }
      latencies.push(r.ms);
      const gotTool = !!r.name && TOOL_NAMES.has(r.name);
      if (gotTool) {
        firstTry++;
        totalFirstTry++;
        if (sc.expect.includes(r.name)) {
          correct++;
          totalCorrect++;
        }
        if (argsOk(r.name, r.argsRaw)) {
          argsValid++;
          totalArgsOk++;
        }
      } else {
        // retry with the assistant-failed + nudge pattern (mirrors executor.ts)
        const retryMsgs = [
          ...messages,
          { role: 'assistant', content: (r.text || '(no content)').slice(0, 500) },
          { role: 'user', content: 'You must call ONE tool. Choose from the tool list. Respond with a single tool call — no text.' },
        ];
        try {
          const r2 = await chatOnce(retryMsgs, 'required');
          if (r2.name && TOOL_NAMES.has(r2.name)) {
            recovered++;
            totalRecovered++;
          }
        } catch {
          /* count as unrecovered */
        }
      }
    }
    const pct = (n) => `${((n / TRIALS) * 100).toFixed(0)}%`;
    console.log(
      `  ${sc.name.padEnd(13)} first-try ${pct(firstTry).padStart(4)}  ` +
        `correct-tool ${pct(correct).padStart(4)}  ` +
        `valid-args ${pct(argsValid).padStart(4)}  ` +
        `(expect: ${sc.expect.join('|')})` +
        (recovered ? `  +${recovered} recovered on retry` : ''),
    );
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p90 = latencies[Math.floor(latencies.length * 0.9)] ?? 0;
  const mean = latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length);

  const firstTryRate = (totalFirstTry / totalCalls) * 100;
  console.log(`\n  ── totals over ${totalCalls} first-try calls ──`);
  console.log(`  first-try valid tool_call : ${firstTryRate.toFixed(0)}%   (blueprint bar: ≥60%, ideal ~90%)`);
  console.log(`  correct tool chosen       : ${((totalCorrect / totalCalls) * 100).toFixed(0)}%`);
  console.log(`  args schema-valid         : ${((totalArgsOk / totalCalls) * 100).toFixed(0)}%`);
  console.log(`  recovered on nudge retry  : ${totalRecovered} of ${totalCalls - totalFirstTry} empties`);
  console.log(`  latency  p50=${(p50 / 1000).toFixed(1)}s  p90=${(p90 / 1000).toFixed(1)}s  mean=${(mean / 1000).toFixed(1)}s   (budget: ≤6s)`);

  console.log(`\n  Verdict:`);
  if (firstTryRate >= 85) {
    console.log(`  → Model is already reliable. Minimal scaffolding needed (maybe just tool-narrowing).`);
  } else if (firstTryRate >= 60) {
    console.log(`  → Usable with the retry path. Few-shot exemplars + tool-narrowing would lift it toward 90%.`);
  } else {
    console.log(`  → Weak. Needs strong scaffolding: few-shot exemplars, tool-narrowing, and likely a skills/playbook layer.`);
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
