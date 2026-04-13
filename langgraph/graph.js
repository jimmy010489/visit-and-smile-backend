// =====================================================
// VISIT & SMILE — LANGGRAPH ORCHESTRATEUR PERSISTANT
// =====================================================
// Architecture : Chef Agent (tool_use) → Sous-agents spécialisés
// Persistance  : PostgreSQL (Supabase) via checkpoint saver
// =====================================================

import { StateGraph, Annotation, END, START } from '@langchain/langgraph';
import { PostgresSaver }                                from '@langchain/langgraph-checkpoint-postgres';
import { ChatAnthropic }                               from '@langchain/anthropic';
import { tool }                                        from '@langchain/core/tools';
import { z }                                           from 'zod';
import pg                                              from 'pg';

import { agentComptable }  from './agents/comptable.js';
import { agentSocial }     from './agents/social.js';
import { agentPlanning }   from './agents/planning.js';

// ─────────────────────────────────────────────
// 1. DÉFINITION DE L'ÉTAT PARTAGÉ DU GRAPHE
// ─────────────────────────────────────────────
const GraphState = Annotation.Root({
    // Événement entrant
    event_type:        Annotation({ reducer: (_, b) => b }),
    payload:           Annotation({ reducer: (_, b) => b }),
    user_id:           Annotation({ reducer: (_, b) => b }),
    message:           Annotation({ reducer: (_, b) => b }),

    // Décisions du chef agent
    agents_to_activate: Annotation({ reducer: (_, b) => b, default: () => [] }),
    agent_instructions: Annotation({ reducer: (_, b) => b, default: () => ({}) }),

    // Résultats des sous-agents (accumulés)
    results: Annotation({
        reducer: (existing, newResults) => ({ ...existing, ...newResults }),
        default: () => ({})
    }),

    // Statut global
    status:   Annotation({ reducer: (_, b) => b, default: () => 'running' }),
    summary:  Annotation({ reducer: (_, b) => b, default: () => '' }),
    errors:   Annotation({ reducer: (a, b) => [...a, ...b], default: () => [] }),
});

// ─────────────────────────────────────────────
// 2. MODÈLE CLAUDE POUR LE CHEF AGENT
// ─────────────────────────────────────────────
const chefAgentModel = new ChatAnthropic({
    model:       'claude-haiku-4-5-20251001',
    maxTokens:   1024,
    apiKey:      process.env.ANTHROPIC_API_KEY,
});

// ─────────────────────────────────────────────
// 3. TOOLS (sous-agents vus comme des outils)
// ─────────────────────────────────────────────
const activerAgentComptable = tool(
    async ({ action, data, priority }) => JSON.stringify({ agent: 'comptable', action, data, priority }),
    {
        name: 'agent_comptable',
        description: 'Active l\'agent comptable pour : enregistrer_vente, generer_rapport, rappel_urssaf, calculer_commission',
        schema: z.object({
            action:   z.enum(['enregistrer_vente', 'generer_rapport', 'rappel_urssaf', 'calculer_commission']),
            data:     z.record(z.any()).optional().describe('Données nécessaires'),
            priority: z.enum(['haute', 'normale', 'basse']).optional().default('normale'),
        }),
    }
);

const activerAgentSocial = tool(
    async ({ action, context, platforms, tone }) => JSON.stringify({ agent: 'social', action, context, platforms, tone }),
    {
        name: 'agent_social',
        description: 'Active l\'agent social pour : generer_post, programmer_publication, analyser_stats',
        schema: z.object({
            action:    z.enum(['generer_post', 'programmer_publication', 'analyser_stats']),
            context:   z.string().describe('Contexte pour la génération de contenu'),
            platforms: z.array(z.string()).optional().default(['instagram']),
            tone:      z.enum(['celebration', 'professionnel', 'informatif', 'inspirant']).optional().default('professionnel'),
        }),
    }
);

const activerAgentPlanning = tool(
    async ({ action, client_id, data }) => JSON.stringify({ agent: 'planning', action, client_id, data }),
    {
        name: 'agent_planning',
        description: 'Active l\'agent planning pour : creer_rdv, envoyer_relance, rappel_anniversaire, sync_agenda',
        schema: z.object({
            action:    z.enum(['creer_rdv', 'envoyer_relance', 'rappel_anniversaire', 'sync_agenda']),
            client_id: z.string().optional(),
            data:      z.record(z.any()).optional(),
        }),
    }
);

const tools = [activerAgentComptable, activerAgentSocial, activerAgentPlanning];
const modelWithTools = chefAgentModel.bindTools(tools);

// ─────────────────────────────────────────────
// 4. NŒUDS DU GRAPHE
// ─────────────────────────────────────────────

/** Chef Agent : analyse l'événement et décide quels agents activer */
async function nodeChefAgent(state) {
    console.log(`[Chef Agent] Analyse de l'événement : ${state.event_type}`);

    const systemPrompt = `Tu es le Chef Agent de Visit & Smile, l'assistant IA d'Alison Mendes, agente immobilière à Orléans.
Tu orchestres 3 agents spécialisés. Analyse chaque événement et active les agents appropriés.

Règles métier :
- nouvelle_vente → TOUJOURS activer agent_comptable (enregistrer_vente) + agent_social (generer_post célébration)
- nouveau_rdv    → TOUJOURS activer agent_planning (creer_rdv + sync_agenda)
- relance_client → activer agent_planning (envoyer_relance)
- demande_rapport → activer agent_comptable (generer_rapport)
- post_reseau    → activer agent_social (generer_post)

Sois précis dans les instructions passées aux agents.`;

    const response = await modelWithTools.invoke([
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: `Événement : ${state.event_type}\nPayload : ${JSON.stringify(state.payload)}\nMessage : ${state.message || ''}\n\nDétermine quels agents activer.`
        }
    ]);

    // Extraire les tool_calls
    const toolCalls = response.tool_calls || [];
    const agentsToActivate = toolCalls.map(tc => tc.name);
    const agentInstructions = {};
    toolCalls.forEach(tc => { agentInstructions[tc.name] = tc.args; });

    console.log(`[Chef Agent] Agents activés : ${agentsToActivate.join(', ')}`);

    return {
        agents_to_activate: agentsToActivate,
        agent_instructions: agentInstructions,
        status: agentsToActivate.length > 0 ? 'routing' : 'completed',
    };
}

/** Router : décide vers quel(s) nœud(s) aller */
function routerChefAgent(state) {
    if (!state.agents_to_activate || state.agents_to_activate.length === 0) {
        return END;
    }
    // Retourner le premier agent non encore traité
    for (const agent of state.agents_to_activate) {
        if (!state.results[agent]) {
            return agent; // nom du nœud suivant
        }
    }
    return 'aggreger'; // tous les agents ont tourné
}

/** Nœud agrégateur : compile les résultats finaux */
async function nodeAgreger(state) {
    const agentsCount = Object.keys(state.results).length;
    const summary = `Chef Agent : ${agentsCount} agent(s) exécuté(s) — ${Object.keys(state.results).join(', ')}`;
    console.log(`[Agrégateur] ${summary}`);
    return { status: 'completed', summary };
}

// ─────────────────────────────────────────────
// 5. CONSTRUCTION DU GRAPHE
// ─────────────────────────────────────────────
function buildGraph(checkpointer) {
    const graph = new StateGraph(GraphState)

        // Nœuds
        .addNode('chef_agent',      nodeChefAgent)
        .addNode('agent_comptable', agentComptable)
        .addNode('agent_social',    agentSocial)
        .addNode('agent_planning',  agentPlanning)
        .addNode('aggreger',        nodeAgreger)

        // Entrée
        .addEdge(START, 'chef_agent')

        // Routage conditionnel depuis le chef agent
        .addConditionalEdges('chef_agent', routerChefAgent, {
            agent_comptable: 'agent_comptable',
            agent_social:    'agent_social',
            agent_planning:  'agent_planning',
            aggreger:        'aggreger',
            [END]:            END,
        })

        // Chaque agent retourne au router pour voir s'il reste des agents
        .addConditionalEdges('agent_comptable', routerChefAgent, {
            agent_social:    'agent_social',
            agent_planning:  'agent_planning',
            aggreger:        'aggreger',
            [END]:            END,
        })
        .addConditionalEdges('agent_social', routerChefAgent, {
            agent_planning:  'agent_planning',
            aggreger:        'aggreger',
            [END]:            END,
        })
        .addConditionalEdges('agent_planning', routerChefAgent, {
            aggreger:        'aggreger',
            [END]:            END,
        })

        // Fin
        .addEdge('aggreger', END);

    return graph.compile({ checkpointer });
}

// ─────────────────────────────────────────────
// 6. INITIALISATION AVEC PERSISTANCE SUPABASE
// ─────────────────────────────────────────────
let compiledGraph = null;

export async function initGraph() {
    if (compiledGraph) return compiledGraph;

    const pool = new pg.Pool({
        connectionString: process.env.SUPABASE_DB_URL,
        // URL format: postgresql://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres
    });

    const checkpointer = new PostgresSaver(pool);
    // Crée les tables de checkpoints si elles n'existent pas
    await checkpointer.setup();

    compiledGraph = buildGraph(checkpointer);
    console.log('[LangGraph] Graphe initialisé avec persistance Supabase ✅');
    return compiledGraph;
}

/**
 * Dispatcher principal : exécute ou reprend une session
 * @param {string} eventType  - type d'évìnement métier
 * @param {object} payload    - données de l'évìnement
 * @param {string} userId     - ID utilisateur Supabase
 * @param {string} threadId   - ID de fil (pour reprendre une session existante)
 */
export async function dispatch(eventType, payload, userId, threadId = null) {
    const graph  = await initGraph();
    const thread = threadId || `${userId}-${Date.now()}`;

    const config = {
        configurable: { thread_id: thread },
        recursionLimit: 10,
    };

    const input = {
        event_type: eventType,
        payload,
        user_id:    userId,
        message:    payload.message || '',
    };

    console.log(`[LangGraph] Dispatch → thread:${thread} event:${eventType}`);

    const result = await graph.invoke(input, config);
    return { thread_id: thread, ...result };
}

/**
 * Récupérer l'état d'une session existante
 */
export async function getState(threadId) {
    const graph = await initGraph();
    const state = await graph.getState({ configurable: { thread_id: threadId } });
    return state;
}
