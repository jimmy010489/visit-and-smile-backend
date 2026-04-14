// =====================================================
// SOUS-AGENT COMPTABLE — Nœud LangGraph
// =====================================================
import { ChatAnthropic } from '@langchain/anthropic';
import { createClient }  from '@supabase/supabase-js';

const model = new ChatAnthropic({
    model:    'claude-haiku-4-5-20251001',
    maxTokens: 600,
    apiKey:   process.env.ANTHROPIC_API_KEY,
});

const supabase = createClient(
    process.env.SUPABASE_URL         || 'https://placeholder.supabase.co',
    process.env.SUPABASE_SERVICE_KEY || 'placeholder-key'
);

export async function agentComptable(state) {
    const instructions = state.agent_instructions?.['agent_comptable'] || {};
    const action       = instructions.action || 'generer_rapport';
    const data         = instructions.data   || {};
    const userId       = state.user_id;

    console.log(`[Agent Comptable] Action : ${action}`);
    let result = {};

    try {
        switch (action) {
            case 'enregistrer_vente': {
                const { data: sale, error } = await supabase.from('sales').insert({ user_id: userId, client_name: data.client_name, property_name: data.property_name, sale_price: data.sale_price, commission_rate: data.commission_rate || 0.03, sale_date: data.sale_date || new Date().toISOString().split('T')[0], status: 'pending' }).select().single();
                if (error) throw error;
                await supabase.from('activity_feed').insert({ user_id: userId, agent: 'compta', icon: 'fa-euro-sign', message: `<strong>Agent Comptable</strong> — Vente enregistrée : ${data.property_name}` });
                result = { sale_id: sale.id, status: 'saved' };
                break;
            }
            case 'generer_rapport': {
                const { data: stats } = await supabase.rpc('get_dashboard_stats', { p_user_id: userId });
                const response = await model.invoke([{ role: 'user', content: `Tu es l'agent comptable de Visit & Smile. Génère un rapport financier concis à partir de ces données : ${JSON.stringify(stats)}. Inclus : CA du mois, URSSAF dues, net, et 2 recommandations. Max 150 mots.` }]);
                const reportText = response.content;
                const usage = response.usage_metadata;
                if (usage?.input_tokens || usage?.output_tokens) { await supabase.from('claude_token_usage').insert({ user_id: userId, agent: 'comptable', input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 }).catch(() => {}); }
                await supabase.from('activity_feed').insert({ user_id: userId, agent: 'compta', icon: 'fa-chart-bar', message: `<strong>Rapport financier</strong> — ${reportText.substring(0, 100)}...` });
                result = { report: reportText, stats };
                break;
            }
            case 'rappel_urssaf': {
                await supabase.from('activity_feed').insert({ user_id: userId, agent: 'compta', icon: 'fa-exclamation-triangle', message: '<strong>Rappel URSSAF</strong> — Déclaration à venir dans moins de 7 jours' });
                result = { reminded: true };
                break;
            }
            case 'calculer_commission': {
                const commission = (data.sale_price || 0) * (data.commission_rate || 0.03);
                const urssaf = commission * 0.22;
                const net = commission - urssaf;
                result = { commission, urssaf, net };
                break;
            }
        }
    } catch (err) {
        console.error('[Agent Comptable] Erreur:', err.message);
        return { results: { ...state.results, agent_comptable: { error: err.message } }, errors: [{ agent: 'comptable', error: err.message }] };
    }

    return { results: { ...state.results, agent_comptable: { action, result } } };
}
