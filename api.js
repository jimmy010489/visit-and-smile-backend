// =====================================================
// VISIT & SMILE — API BACKEND LANGGRAPH
// =====================================================
// Expose le graphe LangGraph via une API REST
// À déployer séparément (Railway, Render, VPS...)
// =====================================================

import express     from 'express';
import cors        from 'cors';
import { createClient } from '@supabase/supabase-js';
import { dispatch, getState, initGraph } from './langgraph/graph.js';

const app  = express();
const PORT = process.env.PORT || 3004;

// Origines autorisées : depuis env + defaults
const allowedOrigins = [
    process.env.FRONTEND_URL || 'https://visit-and-smile.vercel.app',
    'http://localhost:3003',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
];
app.use(cors({
    origin: (origin, cb) => {
        // Autoriser les appels sans origin (curl, mobile, Postman)
        if (!origin) return cb(null, true);
        if (allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error(`CORS bloqué : ${origin}`));
    },
    credentials: true,
}));
app.use(express.json());

// Supabase pour vérifier les sessions utilisateur
// Valeurs par défaut pour que le serveur démarre sans planter (variables ajoutées ensuite)
const supabase = createClient(
    process.env.SUPABASE_URL        || 'https://placeholder.supabase.co',
    process.env.SUPABASE_SERVICE_KEY || 'placeholder-key'
);

// ─── Middleware : vérifier le token Supabase ─────────────
async function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Token manquant' });

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Token invalide' });

    req.user = user;
    next();
}

// ─── Routes ─────────────────────────────────────────────

/**
 * POST /api/graph/dispatch
 * Déclencher une nouvelle session ou reprendre une existante
 */
app.post('/api/graph/dispatch', authMiddleware, async (req, res) => {
    try {
        const { event_type, payload, thread_id } = req.body;

        if (!event_type) {
            return res.status(400).json({ error: 'event_type requis' });
        }

        const result = await dispatch(
            event_type,
            payload || {},
            req.user.id,
            thread_id
        );

        // Sauvegarder la session dans Supabase
        await supabase.from('langgraph_sessions').upsert({
            user_id:          req.user.id,
            thread_id:        result.thread_id,
            event_type,
            status:           result.status || 'completed',
            agents_activated: result.agents_to_activate || [],
            summary:          result.summary || '',
            updated_at:       new Date().toISOString(),
        }, { onConflict: 'thread_id' });

        res.json({
            thread_id:        result.thread_id,
            status:           result.status,
            agents_activated: result.agents_to_activate || [],
            results:          result.results || {},
            summary:          result.summary || '',
        });

    } catch (err) {
        console.error('[API] Dispatch error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/graph/state/:threadId
 * Récupérer l'état persisté d'une session
 */
app.get('/api/graph/state/:threadId', authMiddleware, async (req, res) => {
    try {
        const state = await getState(req.params.threadId);
        if (!state?.values) return res.status(404).json({ error: 'Session introuvable' });
        res.json(state.values);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/graph/sessions
 * Lister les sessions de l'utilisateur
 */
app.get('/api/graph/sessions', authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('langgraph_sessions')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/health
 * Health check — répond immédiatement, sans dépendance Supabase/DB
 */
app.get('/api/health', (_, res) => {
    res.json({ status: 'ok', service: 'Visit & Smile LangGraph API', timestamp: new Date().toISOString() });
});

// ─── Démarrage ──────────────────────────────────────────
async function start() {
    // Démarrer le serveur immédiatement (healthcheck dispo dès le lancement)
    app.listen(PORT, () => {
        console.log(`🚀 Visit & Smile LangGraph API → http://localhost:${PORT}`);
    });

    // Initialiser le graphe en arrière-plan (nécessite SUPABASE_DB_URL)
    if (process.env.SUPABASE_DB_URL) {
        initGraph()
            .then(() => console.log('[LangGraph] Graphe prêt ✅'))
            .catch(err => console.error('[LangGraph] Échec init graphe:', err.message));
    } else {
        console.warn('[LangGraph] SUPABASE_DB_URL manquant — graphe non initialisé (ajoutez la variable)');
    }
}

start().catch(console.error);
