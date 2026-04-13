// =====================================================
// SOUS-AGENT SOCIAL — Nœud LangGraph
// =====================================================
import { ChatAnthropic } from '@langchain/anthropic';
import { createClient }  from '@supabase/supabase-js';

const model = new ChatAnthropic({
    model:    'claude-haiku-4-5-20251001',
    maxTokens: 500,
    apiKey:   process.env.ANTHROPIC_API_KEY,
});

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

export async function agentSocial(state) {
    const instructions = state.agent_instructions?.['agent_social'] || {};
    const action    = instructions.action    || 'generer_post';
    const context   = instructions.context   || '';
    const platforms = instructions.platforms || ['instagram'];
    const tone      = instructions.tone      || 'professionnel';
    const userId    = state.user_id;

    console.log(`[Agent Social] Action : ${action} | Tone : ${tone}`);
    let result = {};

    try {
        switch (action) {

            case 'generer_post': {
                const toneInstructions = {
                    celebration:    'Ton festif et chaleureux, émojis de célébration. Une belle réussite à partager !',
                    professionnel:  'Ton sérieux et expert, met en valeur le bien et la qualité du service.',
                    informatif:     'Ton factuel et utile, donne des infos concrètes sur le marché orléanais.',
                    inspirant:      'Ton motivant et positif, inspire confiance dans le projet immobilier.',
                };

                const response = await model.invoke([{
                    role: 'system',
                    content: `Tu es l'expert social media de Visit & Smile, agence immobilière à Orléans. ${toneInstructions[tone]}`
                }, {
                    role: 'user',
                    content: `Génère un post pour ${platforms.join(' et ')}.\n\nContexte : ${context}\n\nFormat :\n- Hook accrocheur (1ère ligne)\n- Corps (2-3 phrases)\n- Call-to-action\n- Hashtags (5-8 max)\n\nMax 150 mots.`
                }]);

                const caption  = response.content;
                const usage    = response.usage_metadata;

                // Créer un post par plateforme en status "draft" (attend approbation Alison)
                const posts = [];
                for (const platform of platforms) {
                    const { data: post, error } = await supabase
                        .from('social_posts')
                        .insert({
                            user_id:      userId,
                            platform,
                            content_text: caption,
                            status:       'draft',
                            scheduled_at: new Date(Date.now() + 3600000).toISOString(),
                        })
                        .select()
                        .single();

                    if (!error) posts.push(post?.id);
                }

                // Log tokens
                if (usage) {
                    await supabase.from('claude_token_usage').insert({
                        user_id:       userId,
                        agent:         'social',
                        input_tokens:  usage.input_tokens  || 0,
                        output_tokens: usage.output_tokens || 0,
                    }).catch(() => {});
                }

                // Activity feed
                await supabase.from('activity_feed').insert({
                    user_id: userId,
                    agent:   'social',
                    icon:    'fa-instagram',
                    message: `<strong>Agent Social</strong> — ${posts.length} post(s) générés · En attente de votre approbation`,
                });

                result = { posts_created: posts.length, post_ids: posts, caption };
                break;
            }

            case 'analyser_stats': {
                const { data: posts } = await supabase
                    .from('social_posts')
                    .select('platform, status, created_at')
                    .eq('user_id', userId)
                    .gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString());

                result = {
                    total_posts:    posts?.length || 0,
                    by_platform:    posts?.reduce((acc, p) => { acc[p.platform] = (acc[p.platform] || 0) + 1; return acc; }, {}),
                    by_status:      posts?.reduce((acc, p) => { acc[p.status]   = (acc[p.status]   || 0) + 1; return acc; }, {}),
                };
                break;
            }
        }

    } catch (err) {
        console.error('[Agent Social] Erreur:', err.message);
        return {
            results: { ...state.results, agent_social: { error: err.message } },
            errors:  [{ agent: 'social', error: err.message }],
        };
    }

    return {
        results: { ...state.results, agent_social: { action, result } },
    };
}
