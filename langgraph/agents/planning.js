// =====================================================
// SOUS-AGENT PLANNING — Nœud LangGraph
// =====================================================
import { ChatAnthropic } from '@langchain/anthropic';
import { createClient }  from '@supabase/supabase-js';

const model = new ChatAnthropic({
    model:    'claude-haiku-4-5-20251001',
    maxTokens: 300,
    apiKey:   process.env.ANTHROPIC_API_KEY,
});

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

export async function agentPlanning(state) {
    const instructions = state.agent_instructions?.['agent_planning'] || {};
    const action    = instructions.action    || 'sync_agenda';
    const data      = instructions.data      || {};
    const clientId  = instructions.client_id || null;
    const userId    = state.user_id;

    console.log(`[Agent Planning] Action : ${action}`);
    let result = {};

    try {
        switch (action) {

            case 'creer_rdv': {
                const { data: rdv, error } = await supabase
                    .from('appointments')
                    .insert({
                        user_id:    userId,
                        client_id:  clientId,
                        title:      data.title || 'RDV',
                        type:       data.type  || 'visit',
                        start_time: data.start_time,
                        end_time:   data.end_time || null,
                        status:     'scheduled',
                        source:     'agent_ia',
                    })
                    .select()
                    .single();

                if (error) throw error;

                await supabase.from('activity_feed').insert({
                    user_id: userId,
                    agent:   'planning',
                    icon:    'fa-calendar-plus',
                    message: `<strong>Agent Planning</strong> — RDV créé : ${data.title}`,
                });

                result = { rdv_id: rdv.id, status: 'created' };
                break;
            }

            case 'envoyer_relance': {
                // Claude rédige la relance personnalisée
                const response = await model.invoke([{
                    role:    'system',
                    content: 'Tu es l\'assistante d\'Alison Mendes, agente immobilière à Orléans. Tu rédiges des relances post-visite chaleureuses et professionnelles en français.',
                }, {
                    role:    'user',
                    content: `Rédige une relance pour ${data.client_name || 'ce client'} suite à la visite de ${data.property_name || 'ce bien'}. Délai : ${data.days_since_visit || 1} jour(s). Max 5 lignes.`,
                }]);

                const emailContent = response.content;

                // Log dans messages_log
                await supabase.from('messages_log').insert({
                    user_id:   userId,
                    client_id: clientId,
                    channel:   'email',
                    type:      'post_visit',
                    subject:   'Suite à votre visite',
                    content:   emailContent,
                    status:    'pending',
                }).catch(() => {});

                await supabase.from('activity_feed').insert({
                    user_id: userId,
                    agent:   'planning',
                    icon:    'fa-envelope',
                    message: `<strong>Agent Planning</strong> — Relance rédigée pour ${data.client_name || 'client'}`,
                });

                result = { email_drafted: true, content: emailContent };
                break;
            }

            case 'rappel_anniversaire': {
                // Récupérer les clients avec anniversaire dans les 7 prochains jours
                const today = new Date();
                const in7   = new Date(today.getTime() + 7 * 86400000);

                const { data: clients } = await supabase
                    .from('clients')
                    .select('id, first_name, last_name, birthday, email')
                    .eq('user_id', userId)
                    .not('birthday', 'is', null);

                const upcoming = (clients || []).filter(c => {
                    if (!c.birthday) return false;
                    const bday  = new Date(c.birthday);
                    const thisY = new Date(today.getFullYear(), bday.getMonth(), bday.getDate());
                    return thisY >= today && thisY <= in7;
                });

                result = { upcoming_birthdays: upcoming.length, clients: upcoming.map(c => c.first_name + ' ' + c.last_name) };
                break;
            }

            case 'sync_agenda': {
                // Récupérer les RDV à venir non synchronisés
                const { data: rdvs } = await supabase
                    .from('appointments')
                    .select('*')
                    .eq('user_id', userId)
                    .eq('status', 'scheduled')
                    .is('google_event_id', null)
                    .gte('start_time', new Date().toISOString())
                    .limit(5);

                result = { rdvs_to_sync: rdvs?.length || 0 };
                break;
            }
        }

    } catch (err) {
        console.error('[Agent Planning] Erreur:', err.message);
        return {
            results: { ...state.results, agent_planning: { error: err.message } },
            errors:  [{ agent: 'planning', error: err.message }],
        };
    }

    return {
        results: { ...state.results, agent_planning: { action, result } },
    };
}
