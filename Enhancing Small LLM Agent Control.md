# **Engineering a High-Reliability Browser Agent with Google Gemma 4 e4b**

## **Inference-Time Prompting and Structured Reasoning Patterns**

In long-horizon browser-agent control, the choice of structured-reasoning patterns dictates whether a small language model can successfully sequence multi-step operations or degenerate into repetitive loops.1 Single-agent architectures modeled on classic Reasoning-and-Acting (ReAct) frameworks frequently suffer from cognitive overload when executed on models with ![][image1]7B parameters.2 The ReAct paradigm forces a single model to simultaneously process raw observations, generate high-level semantic plans, select specific tools, and format the output.5 Under a 4B parameter budget, such as that of the Google Gemma 4 e4b model, this monolithic processing pattern causes rapid instruction drift, leading the agent to repeat identical actions or enter a state of re-observation paralysis.1  
By contrast, the Plan-and-Execute paradigm mitigates this cognitive bottleneck by decoupling high-level reasoning from low-level tool execution.4 The task is factored into a centralized Planner role—which decomposes the user’s goal into structured, programmatic steps—and an Executor role, which focuses strictly on executing a single atomic tool call based on its immediate sub-task context.4 Because the Executor is isolated from the overall global history, context growth is kept flat, eliminating the attention dilution that causes smaller models to fail during multi-hop interactive chains.4  
This minimalist design is further optimized by adopting the principles of AgentOccam.8 AgentOccam demonstrates that eliminating non-essential, low-embodiment actions—such as scrolling or hovering—significantly enhances task execution on web benchmarks.9 Rather than expecting a local 4B model to master fine-grained spatial navigation, the action space is restricted to highly grounded, high-level primitives: tab.click(index), tab.type(index, text), search(web), and finish.8 Complex multi-hop sequences are structured as a planning tree where the agent relies on deterministic commands to coordinate its actions.8

\+------------------------------------------------------------+  
|                       PLANNER ROLE                         |  
|   Receives global task and outputs programmatic sub-goals   |  
\+-----------------------------+------------------------------+  
                              |  
                              v  
\+------------------------------------------------------------+  
|                      EXECUTOR ROLE                         |  
|   Receives isolated sub-task and accessibility tree node    |  
\+-----------------------------+------------------------------+  
                              |  
                              v  
\+------------------------------------------------------------+  
|                     GBNF GRAMMAR FILTER                    |  
| Forces the output structure to a single valid tool choice  |  
\+-----------------------------+------------------------------+  
                              |  
                              v  
\+------------------------------------------------------------+  
|                 HARNESS STATE ENFORCEMENT                  |  
| Executed by MV3 Extension, preventing repeat command calls |  
\+------------------------------------------------------------+

To implement this on Gemma 4 e4b, the system prompt must strictly define the input boundaries for the Planner and Executor.4 The Planner is invoked first to output a structured planning sequence.4 The Executor is then prompted with only the current sub-task, the active accessibility tree slice, and the immediately preceding action diff.4 This isolation ensures that the model's active attention is fully committed to grounding the current action rather than re-evaluating the global goal.4

## **Dynamic Few-Shot Exemplar Selection and Retrieval Mechanics**

Providing in-context exemplars that demonstrate the exact tool-call loop dramatically increases the sequencing reliability of small language models.13 However, static few-shot prompting is highly inefficient for a 4B parameter model running locally.13 A single web interaction trajectory can easily span several thousand tokens, rapidly consuming the model's active context window and increasing inference latency.13 To overcome this context bottleneck, the agent must employ the Trajectory-as-Exemplar (TaE) prompting pattern pioneered by the Synapse framework, combined with dynamic exemplar retrieval.13  
In a Trajectory-as-Exemplar paradigm, web page states are abstracted into concise, task-relevant observations, filtering out verbose, irrelevant elements.13 Successful historical trajectories are stored in a local memory repository.13 At runtime, rather than loading a massive static prompt, the Chrome MV3 harness queries the memory database to retrieve only the single most relevant trajectory matching the user's current goal.13  
The selection of the retrieval mechanism is critical.18 While dense vector embeddings are standard for semantic retrieval, empirical evaluations show that sparse lexical retrieval algorithms, specifically Okapi BM25, are significantly more effective for tool and function selection.18 Dense embeddings map action-oriented verbs (e.g., "click", "search", "get") close to each other in vector space, failing to capture the discriminative signal between specific tool schemas and noun-based arguments.18 BM25, by contrast, relies on exact term frequencies and inverse document frequencies, ensuring a high-precision match on precise DOM identifiers, target input labels, and tool names.18

User Query: "Find the price of mechanical keyboards on Amazon"  
       |  
       v  
\+--------------+---------------------------------------+  
|  BM25 Query  | Target Keywords: "price", "keyboard"  |  
\+--------------+---------------------------------------+  
       |  
       \+---------\>  
                       |  
                       v  
\+------------------------------------------------------+  
|  RETRIEVED EXEMPLAR PROMPT                           |  
|  Task: "Search product and extract cost"             |  
|  Step 1: tab.type(\[search\_input\], "keyboard")        |  
|  Step 2: tab.click(\[search\_button\])                  |  
|  Step 3: aria.extract(\[product\_price\])               |  
\+------------------------------------------------------+

The dynamic retrieval loop must run locally in the extension background.16 When a user enters a task, the background script runs a tokenized BM25 search over a pre-indexed JSON file containing successful navigation trajectories compiled from datasets such as Mind2Web.20 The single closest trajectory is injected into the system prompt as a structured, one-shot exemplar showing the complete state-action sequence.13 This dynamic gating ensures the model has a highly relevant execution template for the current task without wasting context tokens.7

## **Harness-Side Scaffolding and Finite State Machine Orchestration**

Relying entirely on a language model to manage its own action sequencing is a primary source of failure in small-scale agents.1 To ensure high-reliability multi-step execution, the control logic must be moved out of the model and hardcoded into the Chrome MV3 harness.23 This is achieved by modeling the agent's execution loop as a deterministic Finite State Machine (FSM), separating macroscopic flow control from microscopic model skill.1  
The EvoFSM and AutoWebWorld frameworks demonstrate that establishing explicit, state-based transition rules dramatically improves task success rates in web environments.1 In an FSM-guided architecture, the harness maintains a strict state variable in memory.1 The model is restricted to a specific subset of tools depending on the current state, preventing it from executing actions out of order or repeating previous steps.1

| FSM State | Trigger / Input | Action / Output | Restricted Tool Set | Next State |
| :---- | :---- | :---- | :---- | :---- |
| **Perception** | Task Initialization or Action Feedback | DOM Parsing & AxTree Extraction | aria.extract, vision.read | **Planning** |
| **Planning** | Completed Observation Assembly | Step Decomposing & Step Tracking | next\_step | **Execution** |
| **Execution** | Step Map Verification | Target Action Selection & Call Output | tab.click, tab.type, search | **Verification** |
| **Verification** | Execution Signal Received | DOM Diff Analysis & Progress Audit | next\_step, finish | **Perception (on change)** / **Execution (no change)** |

By enforcing these transitions programmatically, the model is physically prevented from entering "observe-only" loops.1 During the **Execution** state, the harness restricts the Ollama API schema to only allow interactive commands (tab.click, tab.type, search), blocking the agent from calling observation tools like aria.extract.1 This forced-action gating ensures that once an element is identified in the observation phase, the agent is forced to interact with it rather than recursively re-observing the page.1  
Furthermore, progress tracking is handled programmatically in the background script of the MV3 extension.23 The harness maintains an active array of recently executed actions and their target element indices.28 If the model attempts to generate an action identical to one stored in the recent history array (e.g., clicking index \`\` multiple times without a page state change), the harness intervenes.27 It automatically rejects the token generation, rolls back the step, and injects a strict negative system constraint: *"Action tab.click() was already attempted and resulted in no page change. You must select an alternative interactive element."* 27

## **Constrained Decoding and Thinking-Mode Upstream Conflicts**

Constrained decoding ensures that a language model generates syntactically valid outputs matching a formal schema, preventing formatting errors and rambling.15 Tools like llama.cpp and Ollama support GBNF (GGML Backus-Naur Form) and JSON schemas to restrict the model's token output to valid API calls.29 However, combining grammar constraints with Gemma 4's built-in thinking mode introduces a severe technical conflict at the engine level 32:

* **The Conflict Mechanism:** Gemma 4 uses a \<|think|\> token to trigger its internal reasoning channel, generating its thoughts before outputting the final answer.33 Under llama.cpp and Ollama, when a JSON schema or GBNF grammar is active, the grammar constraints are enforced from the very first token generated by the model.32 Because the grammar engine has no awareness of the boundary between the internal thought block and the final content block, it attempts to apply the structured schema to the model's natural-language thoughts.32  
* **The Upstream Failure Mode:** In Ollama, if thinking is enabled alongside a schema, the grammar constraints leak into the reasoning content.32 Because the first character of the model's natural-language thinking process is typically a letter, and the schema expects an opening curly brace {, the grammar engine blocks the token.32 This causes the model to loop infinitely, generating repetitive garbage tokens or crashing with an empty thought block.32

To bypass this upstream engine limitation while preserving both step-by-step thinking capabilities and strictly structured action outputs, the harness must implement a dual-turn execution pattern.4

Turn 1: PLAN PILOT (Thinking ON)  
Prompt: "Analyze observations and output natural-language plan"  
Output: \<|channel\>thought\\n\<channel|\> "First, click the search box."  
  |  
  \+---\> \[Harness extracts plan and strips thoughts\]  
  |  
Turn 2: ACTION EXECUTOR (Thinking OFF, GBNF Grammar Active)  
Prompt: "Given plan and observations, output valid tool call JSON"  
Output: { "tool": "tab.click", "index": 24 } (Strictly constrained)

1. **Turn 1: Plan Pilot Call:** The harness calls the Ollama API with enable\_thinking: true.33 The prompt instructs the model to analyze the accessibility tree and output its step-by-step thinking process and immediate action intent.33 Grammar constraints are disabled, allowing the thinking engine to run freely and generate unconstrained natural language.32  
2. **Turn 2: Action Executor Call:** The harness captures the output of the planning phase.35 It then initiates a second, quick inference call with enable\_thinking: false.33 The prompt contains the current accessibility tree, the planning output, and a strict GBNF grammar or JSON schema defining the tool block.29 Since thinking is deactivated, Ollama generates an empty thought block 33, and the grammar engine successfully constrains the generated output directly to a valid JSON tool call without looping or crashing.32

A highly optimized GBNF grammar for the Executor role is structured as follows:

Code snippet  
root ::= "{" space '"tool"' space ":" space tool-val "," space '"index"' space ":" space integer space "}" space  
tool-val ::= '"tab.click"' | '"tab.type"' | '"search"' | '"finish"'  
integer ::= \[0-9\]+  
space ::= " "\*

This dual-turn execution pattern ensures total system stability, leveraging the model's full reasoning capabilities for planning while guaranteeing syntactically flawless tool calls during execution.4

## **Observation and Action Representation Optimization**

The format of webpage observations fed into a language model is a major factor in its action grounding accuracy.7 Recent empirical work in "Read More, Think More: Revisiting Observation Reduction for Web Agents" (2026) establishes that the optimal observation representation depends heavily on the model's parameter scale and capability 7:

* **Higher-Capability Models (e.g., GPT-5, Gemini 2.5 Pro):** Show a marked preference for detailed, raw HTML representations.12 Their deep attention layers are highly capable of exploiting implicit layout information in HTML for better action grounding.12  
* **Lower-Capability Models (e.g., open-source models ![][image1]7B):** Suffer from severe performance degradation when exposed to verbose HTML.7 The sheer volume of tokens dilutes the model's attention, causing it to hallucinate elements and fail to ground actions.7 For these models, compact, simplified representations—specifically indexed accessibility trees (a11y)—consistently yield the highest task success rates.7

The following table, adapted from the 2026 empirical study on WorkArena L1, illustrates the relationship between observation formats, token counts, and success rates across model scales 7:

| Model Class | Observation Format | Avg. Input Tokens / Step | Task Success Rate (%) | Success Delta (A11y vs. HTML) |
| :---- | :---- | :---- | :---- | :---- |
| **GPT-5.1 (High)** | Accessibility Tree (a11y) | \~14,200 | 60.0% | Base |
| **GPT-5.1 (High)** | Raw HTML (html) | \~112,400 | 73.3% | **\+13.3%** |
| **GPT-OSS 120B (Mid)** | Accessibility Tree (a11y) | \~14,500 | 50.0% | Base |
| **GPT-OSS 120B (Mid)** | Raw HTML (html) | \~115,100 | 38.8% | **\-11.2%** |
| **GPT-OSS 20B (Low)** | Accessibility Tree (a11y) | \~13,900 | 48.2% | Base |
| **GPT-OSS 20B (Low)** | Raw HTML (html) | \~110,800 | 27.6% | **\-20.6%** |

For Gemma 4 e4b, raw HTML must be entirely avoided.7 The harness should only provide a highly pruned accessibility tree.7 Furthermore, appending full sequential page observations to the context window rapidly saturates the model's 32K context limits.7 To retain temporal history without overwhelming the attention heads, the harness must employ a diff-based history representation.7  
Rather than appending the entire accessibility tree at step ![][image2], the harness computes a verbal diff highlighting only the elements that modified, appeared, or disappeared following the last action.27 This verbal diff is highly token-efficient, reducing the context growth rate per step from thousands of tokens to less than a hundred.7 Grounding accuracy is preserved because the model is exposed only to active elements and their immediate state transitions.7

## **Procedural Memory and Agent Workflow Caching**

To prevent local browser agents from re-deriving routine flows from scratch on every run, the system must utilize a procedural memory layer.5 While episodic memory excels at retrieving general historical facts, procedural memory focuses specifically on storing and replaying successful multi-step task solutions, known as "workflows" or "skills".5  
The Agent Workflow Memory (AWM) framework introduces a powerful method for teaching agents to remember and reuse these successful subroutines.41 During execution, AWM monitors the agent's actions and extracts generalized workflows from successful runs on both a task-specific and website-specific level.41 When a similar task is later encountered, the system retrieves the cached workflow and injects it into the prompt as a structured, step-by-step procedural guide.41  
Empirical evaluations of AWM on the WebArena and Mind2Web benchmarks demonstrate massive performance gains 41:  
![][image3]  
![][image4]  
Crucially, AWM also significantly reduces the average number of steps taken to complete a task, directly lowering inference latency and API costs.41  
To implement AWM locally with Gemma 4 e4b, successful trajectories are compiled into abstract, site-specific workflow JSON files stored within the local Chrome extension's storage.41 The step-by-step recipes are generalized by stripping out query-specific details (e.g., replacing "mechanical keyboard" with a {query} variable) 41:

JSON  
{  
  "workflow\_id": "search\_and\_select\_item",  
  "domain": "ebay.com",  
  "task\_description": "Search for a product and select the first listing",  
  "steps": \[  
    {  
      "step\_id": 1,  
      "instruction": "Locate and click the main search input box",  
      "action": "tab.click(\[search\_box\])"  
    },  
    {  
      "step\_id": 2,  
      "instruction": "Type the search query and submit",  
      "action": "tab.type(\[search\_box\], \\"{query}\\")"  
    },  
    {  
      "step\_id": 3,  
      "instruction": "Wait for the results page to load and click the first organic listing",  
      "action": "tab.click(\[first\_result\])"  
    }  
  \]  
}

When the user initiates a task, the harness background script performs a lookup on the current website domain.43 If a matching workflow is found, it is injected into the Planner's context as a strict procedural plan.41 This guides the agent through the sequence, preventing it from losing the plan or terminating prematurely.41

## **Self-Correction and Failure Recovery Protocols**

A major limitation of local 4B parameter models is their inability to recover from a failed or no-op action, such as a click that didn't trigger navigation, or a type operation on a blocked input field.2 When an action fails to alter the environment, small models typically retry the identical action repeatedly, assuming their initial prediction was correct.2  
To resolve this, the MV3 harness must implement a rules-based, non-LLM verification layer.27 Rather than relying on a heavy language model to judge state transitions, the harness background script monitors four browser-native events to detect if an action had an actual effect 27:

1. **URL Transitions:** Detects changes in window.location.href.  
2. **AxTree Structural Shifts:** Monitors mutations in the simplified accessibility tree.  
3. **Focus Shifts:** Tracks if focus transitioned to a different element ID.  
4. **Network Requests:** Monitors active network traffic.

If an action is executed and none of these native indicators register a change within a defined window, the harness flags an execution failure.27 Instead of feeding the unchanged accessibility tree back to the model, the harness intercepts the loop and injects a direct, instruction-based recovery prompt 2:

\== HARNESS EXCEPTION DETECTED \==  
Action tab.click() was executed but resulted in no page change, focus transition, or network traffic.  
\- Target element  is likely blocked or intercepted.  
\- Recovery Instruction: Do not retry click(). You must select a different element or try a different approach.

By feeding this direct error state back to the model, the agent is forced to adjust its strategy.2 This prevents the model from repeating failed actions and helps it find alternative paths to complete the task.2

## **Supervised Fine-Tuning and Distillation of Gemma 4 e4b**

When inference-time scaffolding reaches its limits, supervised fine-tuning (SFT) is required to internalize web navigation patterns directly into the model's weights.47 Fine-tuning Gemma 4 e4b on verified browser trajectories teaches the model to understand compact accessibility tree representations and reliably output structured tool calls.47

### **Target Datasets and Volume Requirements**

For robust generalist web-agent performance, SFT data must combine high-quality web-use traces with negative samples to reduce hallucinations.50 The following datasets provide a strong foundation for fine-tuning:

| Dataset | Volume (Samples / APIs) | Primary Target Behavior | Key Features |
| :---- | :---- | :---- | :---- |
| **Mind2Web** | 2,350 tasks, 137 real websites | Diverse, real-world web interactions | Crowdsourced action sequences, raw HTML, network traffic, multi-domain 22 |
| **ToolACE** | 11.3k instances, 26,507 APIs | Multi-turn function calling | Self-evolution synthesis, complex API structures, structured JSON 52 |
| **Agent-FLAN** | 34.4k instances | Hallucination reduction, task planning | Decomposed agent tasks, negative sample learning, general ability alignment 50 |

To fine-tune Gemma 4 e4b, a balanced mixture of approximately 10,000 to 15,000 high-quality, multi-turn trajectories is recommended.53 Over-indexing on web-only datasets can cause catastrophic forgetting of the model's general instruction-following and reasoning capabilities.47 To prevent this, the training mixture must preserve a minimum of 20% general instruction-following and multi-turn chat data.47

### **Fine-Tuning Recipe with Unsloth**

Fine-tuning can be efficiently executed using the Unsloth framework.47 Unsloth supports vision, text, and RL training for Gemma 4 e4b with a \~1.5x speedup and \~60% less memory usage, allowing QLoRA training to run within 10GB of VRAM.47  
To preserve the model's reasoning capabilities, it is critical to train using a mixture of thinking-style examples.47 Unsloth recommends keeping a minimum of 75% reasoning-style examples in the training set.47 Depending on the desired behavior, developers can configure the tokenizer to target either the standard or the thinking-enhanced chat template 47:

Python  
from unsloth import FastModel  
from unsloth.chat\_templates import get\_chat\_template

max\_seq\_length \= 8192  \# Optimized for compact accessibility trees  
model, tokenizer \= FastModel.from\_pretrained(  
    model\_name="unsloth/gemma-4-E4B-it",  
    max\_seq\_length=max\_seq\_length,  
    load\_in\_4bit=True,  
)

\# Apply the thinking template to preserve reasoning pathways  
tokenizer \= get\_chat\_template(  
    tokenizer,  
    chat\_template="gemma-4-thinking"  
)

During training, standard LoRA target modules must be configured to update attention projection layers (q\_proj, k\_proj, v\_proj, o\_proj, gate\_proj, up\_proj, down\_proj) to ensure proper model alignment.47

### **Servicing the Fine-Tuned LoRA in Ollama**

Once fine-tuning is complete, the LoRA adapter is merged with the base model and exported to GGUF format.47 It can then be served locally via Ollama by writing a custom Modelfile 33:

Dockerfile  
FROM./gemma-4\-e4b-agentic.gguf

\# Set DeepMind's official standardized sampling parameters  
PARAMETER temperature 1.0  
PARAMETER top\_p 0.95  
PARAMETER top\_k 64

\# Configure system prompts and enable thinking mode  
SYSTEM """  
\<|think|\>  
You are an expert web-agent executor. Your task is to analyze the compact accessibility tree and output a valid tool call.  
"""

### **Functional Token Softmax Mapping (Octopus Paradigm)**

For highly repetitive, latency-sensitive environments, developers can adopt the Octopus functional token mapping paradigm.56 Instead of forcing the model to generate verbose, multi-token JSON strings for tool names (which is prone to spelling errors and formatting hallucinations), each discrete tool in the MV3 browser extension is mapped to a unique, single token in the vocabulary (e.g., \<nexa\_0\> for tab.click, \<nexa\_1\> for tab.type, and \<nexa\_2\> for search).57  
During fine-tuning, the tokenizer's vocabulary is expanded to include these special functional tokens, and the model's language head is modified accordingly.57 This transforms tool selection into a single-token Softmax classification task during inference.57 The model predicts the target tool with a single forward pass, reducing decoding latency, eliminating syntax hallucinations, and saving up to 95% of the context length required for tool definitions.56

## **Gemma-4-Specific Guidance and Runtime Configuration**

To achieve optimal performance on Google Gemma 4 models, the local deployment environment must align with Google DeepMind's official runtime and prompting guidelines 33:

### **Standardized Sampling Parameters**

To prevent logical drift and maintain structured alignment, DeepMind recommends a strict, standardized sampling configuration across all agentic tasks 33:  
![][image5]  
Deviating from these values—such as lowering the temperature to 0.0 under the assumption that it enforces deterministic behavior—can degrade Gemma 4's internal reasoning pathways, leading to repetitive phrasing loops.15

### **Multi-Turn Thought Stripping**

This is the most critical infrastructure requirement for long-horizon agent loops.33 Gemma 4 is trained to generate thoughts strictly on its current turn.33 In multi-turn conversations, historical model outputs must only include the final response or tool call.33 Thoughts from previous model turns must be stripped before the next user turn begins 33:

\-- CORRECT MULTI-TURN HISTORY FORMAT \--  
User:  
Assistant: tab.click()  // Stripped of internal thought blocks  
User:  
Assistant: \<|channel\>thought\\n\<channel|\>tab.type(, "keyboard")

If the Chrome MV3 harness appends the model's full reasoning output (including intermediate thoughts bounded by \<|channel\>thought\\n and \<channel|\>) back into the conversation history, the attention heads will over-index on past thought processes.34 This causes severe context bloat, degrades planning performance, and leads to infinite flailing loops where the agent repeats previous thoughts instead of analyzing the new page state.33

## **Systematic Comparative Analysis and Ranked Execution Roadmap**

To systematically resolve action sequencing failures in the Google Gemma 4 e4b browser agent, a phased roadmap is established below. This sequence begins with low-cost, high-impact inference modifications and moves toward more complex, target-specific fine-tuning options.

### **Ranked Optimization Techniques**

| Technique | Inference-time or Fine-tune | Expected Impact on Multi-step Success | Implementation Effort | Evidence Strength | Source |
| :---- | :---- | :---- | :---- | :---- | :---- |
| **Dynamic Multi-Turn Thought Stripping** | Inference-time | Very High (Prevents cognitive loops and attention drift) | Very Low | Definitive | Google Official Guidance 33 |
| **Harness-Side FSM Control (Flow/Skill Decoupling)** | Inference-time | Very High (Blocks illegal repeated actions and flail loops) | Medium | Strong | EvoFSM / AutoWebWorld 1 |
| **Compact Accessibility Trees (a11y) & Verbal Diff History** | Inference-time | High (Eliminates hallucinations from verbose HTML context) | Medium | Strong | Read More, Think More 7 |
| **Dual-Turn Planning / GBNF Decoupling** | Inference-time | High (Bypasses llama.cpp grammar-thinking conflicts) | Medium | Definitive | Llama.cpp Issue \#20345 32 |
| **AgentOccam Action Space Simplification** | Inference-time | High (Removes low-embodiment interaction bottlenecks) | Low | Strong | AgentOccam 9 |
| **Lightweight SDO Signal Failure Detectors** | Inference-time | High (Forces tactical recovery prompts on no-op actions) | Medium | Strong | FocusAgent 27 |
| **BM25 Dynamic Exemplar Trajectory Retrieval** | Inference-time | Medium-High (Aligns navigation sequences with historical templates) | Medium | Strong | Synapse / BM25 13 |
| **Agent Workflow Memory (AWM) Caching** | Inference-time | Medium-High (Allows replaying of successful subroutines) | High | Strong | AWM Mind2Web 41 |
| **Target-Specific QLoRA Fine-Tuning** | Fine-tune | Very High (Internalizes tool-call structures and navigation logic) | High | Strong | Unsloth / Mind2Web / Agent-FLAN 22 |
| **Functional Token Softmax Mapping** | Fine-tune | High (Minimizes decoding latency and tool formatting syntax errors) | High | Strong | Octopus v2 / ATLAS 56 |

### **Sequenced Implementation Roadmap**

#### **Phase 1: Zero-Cost System Optimization (Days 1–3)**

* Configure DeepMind's standardized sampling parameters (temperature=1.0, top\_p=0.95, top\_k=64) in the Ollama Modelfile.33  
* Implement a regex-based stripper in the Chrome MV3 background script to entirely remove prior thought blocks (\<|channel\>thought... \<channel|\>) from multi-turn conversation history before sending the next turn to Ollama.33  
* Apply the AgentOccam action space simplification: remove non-essential, low-embodiment commands (such as scrolling and hovering) from the Executor's tool schema.9

#### **Phase 2: Data & Observation Refinement (Days 4–7)**

* Convert webpage inputs into compact, indexed accessibility tree (a11y) observations, enforcing a hard limit of 12K characters.7  
* Implement a verbal diff-based history representation in the background script, replacing full past observations with compact change summaries.7  
* Integrate a local, background BM25 retriever utilizing rank\_bm25 over tokenized successful trajectories to inject high-precision, one-shot exemplars matching the current task.13

#### **Phase 3: Scaffolding & State Control (Days 8–14)**

* Implement the FSM Scaffold in the MV3 extensionbackground script to programmatically track execution states and restrict tool schemas based on the active state (e.g., locking observation tools during execution phases).1  
* Set up Signal-Driven Observation (SDO) browser-native verifiers (URL tracking, DOM mutations, active focus detection) to monitor action impact.27 If a no-op action is detected, inject a hard tactical error constraint to prevent repetitive command execution.2  
* Configure the Dual-Turn thinking/grammar decoupling: run the Planner with thinking ON, strip the thoughts, and then execute the Executor call with thinking OFF under strict GBNF grammar constraints.32

#### **Phase 4: Trajectory Caching & Retrieval (Days 15–21)**

* Integrate the Agent Workflow Memory (AWM) framework.41 Cache successful multi-step execution traces as generalized procedural schemas in the local storage.43  
* Set up a background workflow lookup based on target domain matching, injecting retrieved workflows directly as structural sub-goals into the Planner's context.41

#### **Phase 5: Target-Specific Fine-Tuning (Days 22–30+)**

* Examine performance baselines. If sequencing reliability requires further weight updates, construct a training corpus of 10,000–15,000 trajectories compiled from Mind2Web, ToolACE, and Agent-FLAN.22  
* Ensure the training mixture maintains a minimum of 25% general instruction and thinking-style data to mitigate catastrophic forgetting.47  
* Train a 4-bit QLoRA on the Gemma 4 e4b base using the Unsloth framework, targets attention layers, and exports the merged model to GGUF format.47 Serve the compiled model locally via Ollama.33

#### **Works cited**

1. EvoFSM: Controllable Self-Evolution for Deep Research with Finite State Machines \- arXiv, accessed June 14, 2026, [https://arxiv.org/html/2601.09465v2](https://arxiv.org/html/2601.09465v2)  
2. World-Model–Augmented Web Agents with Action Correction \- arXiv, accessed June 14, 2026, [https://arxiv.org/html/2602.15384v1](https://arxiv.org/html/2602.15384v1)  
3. EvoFSM: Controllable Self-Evolution for Deep Research with Finite State Machines \- OpenReview, accessed June 14, 2026, [https://openreview.net/pdf/0611ca44fc9a6d022d62270a19ff03a20042dd94.pdf](https://openreview.net/pdf/0611ca44fc9a6d022d62270a19ff03a20042dd94.pdf)  
4. Plan-and-Execute Agent Architecture on GPU Cloud: Cut Multi-Agent Inference Costs 90% with Heterogeneous Model Routing (2026 Guide) | Spheron Blog, accessed June 14, 2026, [https://www.spheron.network/blog/plan-and-execute-agent-architecture-gpu-cloud/](https://www.spheron.network/blog/plan-and-execute-agent-architecture-gpu-cloud/)  
5. LLM Agent Architectures in 2026: Core Components and Patterns \- Future AGI, accessed June 14, 2026, [https://futureagi.com/blog/llm-agent-architectures-core-components/](https://futureagi.com/blog/llm-agent-architectures-core-components/)  
6. Open-source LLMs as LangChain Agents \- Hugging Face, accessed June 14, 2026, [https://huggingface.co/blog/open-source-llms-as-agents](https://huggingface.co/blog/open-source-llms-as-agents)  
7. Read More, Think More: Revisiting Observation Reduction for Web Agents \- arXiv, accessed June 14, 2026, [https://arxiv.org/html/2604.01535v1](https://arxiv.org/html/2604.01535v1)  
8. AgentOccam: A Simple Yet Strong Baseline for LLM-Based Web Agents \- GitHub, accessed June 14, 2026, [https://github.com/amazon-science/AgentOccam](https://github.com/amazon-science/AgentOccam)  
9. \[Papierüberprüfung\] AgentOccam: A Simple Yet Strong Baseline for LLM-Based Web Agents, accessed June 14, 2026, [https://www.themoonlight.io/de/review/agentoccam-a-simple-yet-strong-baseline-for-llm-based-web-agents](https://www.themoonlight.io/de/review/agentoccam-a-simple-yet-strong-baseline-for-llm-based-web-agents)  
10. AgentOccam: A Simple Yet Strong Baseline for LLM-Based Web Agents \- arXiv, accessed June 14, 2026, [https://arxiv.org/html/2410.13825v1](https://arxiv.org/html/2410.13825v1)  
11. VisualWebArena: Evaluating Multimodal Agents on Realistic Visually Grounded Web Tasks, accessed June 14, 2026, [https://arxiv.org/html/2401.13649v2](https://arxiv.org/html/2401.13649v2)  
12. Revisiting Observation Reduction for Web Agents \- arXiv, accessed June 14, 2026, [https://arxiv.org/pdf/2604.01535](https://arxiv.org/pdf/2604.01535)  
13. synapse: trajectory-as-exemplar prompting \- arXiv, accessed June 14, 2026, [https://arxiv.org/pdf/2306.07863](https://arxiv.org/pdf/2306.07863)  
14. SYNAPSE: TRAJECTORY-AS-EXEMPLAR PROMPTING WITH MEMORY FOR COMPUTER CONTROL, accessed June 14, 2026, [https://personal.ntu.edu.sg/boan/papers/ICLR24\_SYNAPSE.pdf](https://personal.ntu.edu.sg/boan/papers/ICLR24_SYNAPSE.pdf)  
15. Llama.cpp vs MLX on Apple Mx \- Medium, accessed June 14, 2026, [https://medium.com/@michael.hannecke/llama-cpp-vs-mlx-on-apple-mx-775ee59df0ee](https://medium.com/@michael.hannecke/llama-cpp-vs-mlx-on-apple-mx-775ee59df0ee)  
16. batiai/gemma4-e4b \- Ollama, accessed June 14, 2026, [https://ollama.com/batiai/gemma4-e4b](https://ollama.com/batiai/gemma4-e4b)  
17. Synapse: Trajectory-as-Exemplar Prompting with Memory for Computer Control, accessed June 14, 2026, [https://www.semanticscholar.org/paper/Synapse%3A-Trajectory-as-Exemplar-Prompting-with-for-Zheng-Wang/eaa7853facb9b49444b48a96192cb4be66b62671](https://www.semanticscholar.org/paper/Synapse%3A-Trajectory-as-Exemplar-Prompting-with-for-Zheng-Wang/eaa7853facb9b49444b48a96192cb4be66b62671)  
18. BM25 beat dense embeddings for tool/function selection in my agent retriever \- anyone running a hybrid? : r/Rag \- Reddit, accessed June 14, 2026, [https://www.reddit.com/r/Rag/comments/1u390k4/bm25\_beat\_dense\_embeddings\_for\_toolfunction/](https://www.reddit.com/r/Rag/comments/1u390k4/bm25_beat_dense_embeddings_for_toolfunction/)  
19. Hybrid Search: RAG for Real-Life Production-Grade Applications \- LanceDB, accessed June 14, 2026, [https://www.lancedb.com/blog/hybrid-search-rag-for-real-life-production-grade-applications-e1e727b3965a](https://www.lancedb.com/blog/hybrid-search-rag-for-real-life-production-grade-applications-e1e727b3965a)  
20. Enhance Your LLM Agents with BM25: Lightweight Retrieval That Works | Towards AI, accessed June 14, 2026, [https://towardsai.net/p/artificial-intelligence/enhance-your-llm-agents-with-bm25-lightweight-retrieval-that-works](https://towardsai.net/p/artificial-intelligence/enhance-your-llm-agents-with-bm25-lightweight-retrieval-that-works)  
21. ltzheng/Synapse: \[ICLR 2024\] Trajectory-as-Exemplar Prompting with Memory for Computer Control \- GitHub, accessed June 14, 2026, [https://github.com/ltzheng/Synapse](https://github.com/ltzheng/Synapse)  
22. Mind2Web: Towards a Generalist Agent for the Web \- GitHub Pages, accessed June 14, 2026, [https://osu-nlp-group.github.io/Mind2Web/](https://osu-nlp-group.github.io/Mind2Web/)  
23. AutoWebWorld: Synthesizing Infinite Verifiable Web Environments via Finite State Machines, accessed June 14, 2026, [https://arxiv.org/html/2602.14296v1](https://arxiv.org/html/2602.14296v1)  
24. (PDF) AutoWebWorld: Synthesizing Infinite Verifiable Web Environments via Finite State Machines \- ResearchGate, accessed June 14, 2026, [https://www.researchgate.net/publication/400855151\_AutoWebWorld\_Synthesizing\_Infinite\_Verifiable\_Web\_Environments\_via\_Finite\_State\_Machines](https://www.researchgate.net/publication/400855151_AutoWebWorld_Synthesizing_Infinite_Verifiable_Web_Environments_via_Finite_State_Machines)  
25. EvoFSM: Controllable Self-Evolution for Deep Research with Finite State Machines \- arXiv, accessed June 14, 2026, [https://arxiv.org/html/2601.09465v1](https://arxiv.org/html/2601.09465v1)  
26. Finite State Machines and how to build any step by step flow in React From theory to practice \- The Miners, accessed June 14, 2026, [https://blog.codeminer42.com/finite-state-machines-and-how-to-build-any-step-by-step-flow-in-react/](https://blog.codeminer42.com/finite-state-machines-and-how-to-build-any-step-by-step-flow-in-react/)  
27. Signal-Driven Observation for Long-Horizon Web Agents \- arXiv, accessed June 14, 2026, [https://arxiv.org/html/2606.06708v1](https://arxiv.org/html/2606.06708v1)  
28. standalone memory system for AI coding agents \- GitHub, accessed June 14, 2026, [https://github.com/axiomhq/agent-memory](https://github.com/axiomhq/agent-memory)  
29. llama.cpp/grammars/README.md at master · ggml-org/llama.cpp · GitHub, accessed June 14, 2026, [https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)  
30. Bring state-of-the-art agentic skills to the edge with Gemma 4 \- Google Developers Blog, accessed June 14, 2026, [https://developers.googleblog.com/bring-state-of-the-art-agentic-skills-to-the-edge-with-gemma-4/](https://developers.googleblog.com/bring-state-of-the-art-agentic-skills-to-the-edge-with-gemma-4/)  
31. LlamaCppEx v0.8.5 \- Hexdocs, accessed June 14, 2026, [https://hexdocs.pm/llama\_cpp\_ex/](https://hexdocs.pm/llama_cpp_ex/)  
32. Grammar enforcement not applied when thinking is enabled (response\_format \+ enable\_thinking) · Issue \#20345 · ggml-org/llama.cpp \- GitHub, accessed June 14, 2026, [https://github.com/ggml-org/llama.cpp/issues/20345](https://github.com/ggml-org/llama.cpp/issues/20345)  
33. gemma4 \- Ollama, accessed June 14, 2026, [https://ollama.com/library/gemma4](https://ollama.com/library/gemma4)  
34. Gemma 4 model card | Google AI for Developers, accessed June 14, 2026, [https://ai.google.dev/gemma/docs/core/model\_card\_4](https://ai.google.dev/gemma/docs/core/model_card_4)  
35. Thinking mode in Gemma | Google AI for Developers, accessed June 14, 2026, [https://ai.google.dev/gemma/docs/capabilities/thinking](https://ai.google.dev/gemma/docs/capabilities/thinking)  
36. How are people getting reliable JSON outputs from local LLMs for action generation? : r/LLMDevs \- Reddit, accessed June 14, 2026, [https://www.reddit.com/r/LLMDevs/comments/1u03oef/how\_are\_people\_getting\_reliable\_json\_outputs\_from/](https://www.reddit.com/r/LLMDevs/comments/1u03oef/how_are_people_getting_reliable_json_outputs_from/)  
37. unsloth/gemma-4-E4B-it \- Hugging Face, accessed June 14, 2026, [https://huggingface.co/unsloth/gemma-4-E4B-it](https://huggingface.co/unsloth/gemma-4-E4B-it)  
38. \[2604.01535\] Read More, Think More: Revisiting Observation Reduction for Web Agents, accessed June 14, 2026, [https://arxiv.org/abs/2604.01535](https://arxiv.org/abs/2604.01535)  
39. Read More, Think More: Revisiting Observation Reduction for Web Agents \- ResearchGate, accessed June 14, 2026, [https://www.researchgate.net/publication/403467761\_Read\_More\_Think\_More\_Revisiting\_Observation\_Reduction\_for\_Web\_Agents](https://www.researchgate.net/publication/403467761_Read_More_Think_More_Revisiting_Observation_Reduction_for_Web_Agents)  
40. Masafumi OYAMADA | Chief Scientist | NEC Corporation, Tokyo | Nippon Electric Company, Limited | CRL | Research profile \- ResearchGate, accessed June 14, 2026, [https://www.researchgate.net/profile/Masafumi-Oyamada](https://www.researchgate.net/profile/Masafumi-Oyamada)  
41. Agent Workflow Memory (AWM) \- Arize AI, accessed June 14, 2026, [https://arize.com/glossary/agent-workflow-memory-awm/](https://arize.com/glossary/agent-workflow-memory-awm/)  
42. ReasoningBank: Enabling agents to learn from experience \- Google Research, accessed June 14, 2026, [https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/](https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/)  
43. Agent Workflow Memory \- OpenReview, accessed June 14, 2026, [https://openreview.net/forum?id=PfYg3eRrNi](https://openreview.net/forum?id=PfYg3eRrNi)  
44. ICML Poster Agent Workflow Memory, accessed June 14, 2026, [https://icml.cc/virtual/2025/poster/45496](https://icml.cc/virtual/2025/poster/45496)  
45. zorazrw/agent-workflow-memory: AWM \- GitHub, accessed June 14, 2026, [https://github.com/zorazrw/agent-workflow-memory](https://github.com/zorazrw/agent-workflow-memory)  
46. World-Model-Augmented Web Agents with Action Correction \- arXiv, accessed June 14, 2026, [https://arxiv.org/pdf/2602.15384](https://arxiv.org/pdf/2602.15384)  
47. Gemma 4 Fine-tuning Guide | Unsloth Documentation, accessed June 14, 2026, [https://unsloth.ai/docs/models/gemma-4/train](https://unsloth.ai/docs/models/gemma-4/train)  
48. Agentic Tool Use in Large Language Models \- arXiv, accessed June 14, 2026, [https://arxiv.org/html/2604.00835v1](https://arxiv.org/html/2604.00835v1)  
49. FunctionGemma: Bringing bespoke function calling to the edge \- Google Blog, accessed June 14, 2026, [https://blog.google/innovation-and-ai/technology/developers-tools/functiongemma/](https://blog.google/innovation-and-ai/technology/developers-tools/functiongemma/)  
50. Designing Data and Methods of Effective Agent Tuning for Large Language Models \- arXiv, accessed June 14, 2026, [https://arxiv.org/html/2403.12881v1](https://arxiv.org/html/2403.12881v1)  
51. MIND2WEB: Towards a Generalist Agent for the Web, accessed June 14, 2026, [https://proceedings.neurips.cc/paper\_files/paper/2023/file/5950bf290a1570ea401bf98882128160-Paper-Datasets\_and\_Benchmarks.pdf](https://proceedings.neurips.cc/paper_files/paper/2023/file/5950bf290a1570ea401bf98882128160-Paper-Datasets_and_Benchmarks.pdf)  
52. GitHub \- mlabonne/llm-datasets: Curated list of datasets and tools for post-training., accessed June 14, 2026, [https://github.com/mlabonne/llm-datasets](https://github.com/mlabonne/llm-datasets)  
53. Run ToolACE-2.5-Llama-3.1-8B API | Serverless Inference | 32K Context | Flat-Rate Pricing, accessed June 14, 2026, [https://featherless.ai/models/Team-ACE/ToolACE-2.5-Llama-3.1-8B](https://featherless.ai/models/Team-ACE/ToolACE-2.5-Llama-3.1-8B)  
54. Training Datasets \- Starter DOCS, accessed June 14, 2026, [https://starterdocs.js.org/docs/comparisons/ai-training-data](https://starterdocs.js.org/docs/comparisons/ai-training-data)  
55. ToolACE-MT: Non-Autoregressive Generation for Agentic Multi-Turn Interaction, accessed June 14, 2026, [https://openreview.net/forum?id=KznJt9Fhjc](https://openreview.net/forum?id=KznJt9Fhjc)  
56. Octopus V2: A Revolutionary On-Device Language Model | by Frank Morales Aguilera | The Deep Hub | Medium, accessed June 14, 2026, [https://medium.com/thedeephub/octopus-v2-a-revolutionary-on-device-language-model-3d59dbca64e2](https://medium.com/thedeephub/octopus-v2-a-revolutionary-on-device-language-model-3d59dbca64e2)  
57. Octopus v2: On-device language model for super agent \- arXiv, accessed June 14, 2026, [https://arxiv.org/html/2404.01744v5](https://arxiv.org/html/2404.01744v5)  
58. \[short\] Octopus v2: On-device language model for super agent \- YouTube, accessed June 14, 2026, [https://www.youtube.com/watch?v=ompa6\_82sls](https://www.youtube.com/watch?v=ompa6_82sls)  
59. ArXiv Papers Browser \- Teng Wang, accessed June 14, 2026, [http://ttengwang.com/arxiv-papers.html](http://ttengwang.com/arxiv-papers.html)

[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAZCAYAAAA4/K6pAAAAjElEQVR4XmNgGAXkAEZ0AWKBIxD/B+IWdAlCIJYBojEHXYIQqGSAaAxClyAEpgDxPyC2QJcgBNYD8Q8gVkKXIAbkMkCca4UuQSooYYAYFIwuQSqIYoAYlI0uQSqwY4AY1IYuQSpQAeKfQDwHXYJUIAjE+9EFBweQBmJvIjHWFCoCxOZEYk2onlFALQAA8QEYC8J6qJQAAAAASUVORK5CYII=>

[image2]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACsAAAAaCAYAAAAue6XIAAAA1klEQVR4Xu2TPQoCQQyFo4gWXsNWLLT0BIJewloQ8RgexcrW1srKO6iwglr6U+kLMwtjEMkimyoffDCTvIXHskvkOM4/nOTgFze4lcOS2cFXohoOT+XQiBUVKNuhEK7KhRGqsn04gGsK4WG8W6MqO4NzCsFLvLPWqMrmcHAih4aoy7YpBCty8YU67Cntxmc0qMsuSRkETThSyt+/FnVZDl3l0JhCZfkny9kkZysKlW3F8zNdGMIviHs05EKyoBB8wJrYlc0dZvAA9/AIz3CchhzHcRzngzcjETkwh7m/rQAAAABJRU5ErkJggg==>

[image3]: <data:image/png;base64,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>

[image4]: <data:image/png;base64,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>

[image5]: <data:image/png;base64,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>