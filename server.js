import express from 'express';
import cors from 'cors';
import webpush from 'web-push';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';

const { Pool } = pkg;

// Resolve directory paths in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for frontend clients
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Files for local persistence (fallback)
const VAPID_FILE = path.join(__dirname, 'vapid.json');
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');

// --- 1. Supabase PostgreSQL Connection Pool ---
let dbPool = null;
if (process.env.DATABASE_URL) {
  try {
    dbPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false // Required for hosted databases like Supabase/Render
      }
    });
    console.log('🔌 Conectado a la base de datos PostgreSQL (Supabase/Render).');
    
    // Auto-create subscriptions table if it doesn't exist
    dbPool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        endpoint TEXT UNIQUE NOT NULL,
        keys JSONB NOT NULL,
        reminder_hours JSONB DEFAULT '[10, 20]',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `).then(() => {
      // Run quick migration in case column wasn't there
      return dbPool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS reminder_hours JSONB DEFAULT '[10, 20]'`);
    }).catch(err => {
      console.error('❌ Error al intentar auto-crear o migrar la tabla subscriptions:', err);
    });
  } catch (err) {
    console.error('❌ Fallo al inicializar la base de datos PostgreSQL:', err);
    dbPool = null;
  }
}

if (!dbPool) {
  console.log('📂 Usando base de datos local basada en archivo JSON (subscriptions.json).');
}

// --- 2. Setup VAPID Keys ---
let vapidKeys;
if (fs.existsSync(VAPID_FILE)) {
  try {
    vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    console.log('🔑 Llaves VAPID existentes cargadas desde vapid.json');
  } catch (err) {
    console.error('Error al leer vapid.json, regenerando claves.', err);
  }
}

if (!vapidKeys) {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
  console.log('✅ Nuevas llaves VAPID generadas en vapid.json');
}

webpush.setVapidDetails(
  'mailto:lucas@example.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// --- 3. Subscription Storage Helpers ---
async function getSubscriptions() {
  if (dbPool) {
    try {
      const res = await dbPool.query('SELECT endpoint, keys, reminder_hours FROM subscriptions');
      return res.rows.map(row => ({
        endpoint: row.endpoint,
        keys: row.keys,
        reminder_hours: Array.isArray(row.reminder_hours) 
          ? row.reminder_hours 
          : (typeof row.reminder_hours === 'string' ? JSON.parse(row.reminder_hours) : (row.reminder_hours || [10, 20]))
      }));
    } catch (err) {
      console.error('Error al leer suscripciones de PostgreSQL:', err);
      return [];
    }
  } else {
    if (!fs.existsSync(SUBS_FILE)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
      return raw.map(sub => ({
        endpoint: sub.endpoint,
        keys: sub.keys,
        reminder_hours: sub.reminder_hours || [10, 20]
      }));
    } catch (err) {
      return [];
    }
  }
}

async function addSubscription(sub) {
  const hours = sub.reminder_hours || [10, 20];
  if (dbPool) {
    try {
      await dbPool.query(
        'INSERT INTO subscriptions (endpoint, keys, reminder_hours) VALUES ($1, $2, $3) ON CONFLICT (endpoint) DO UPDATE SET keys = EXCLUDED.keys, reminder_hours = EXCLUDED.reminder_hours',
        [sub.endpoint, JSON.stringify(sub.keys), JSON.stringify(hours)]
      );
      console.log('[DB] Suscripción insertada/actualizada en Postgres.');
    } catch (err) {
      console.error('Error al insertar suscripción en PostgreSQL:', err);
    }
  } else {
    let subs = [];
    if (fs.existsSync(SUBS_FILE)) {
      try {
        subs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
      } catch (e) {}
    }
    const existsIndex = subs.findIndex(s => s.endpoint === sub.endpoint);
    const newSubData = {
      endpoint: sub.endpoint,
      keys: sub.keys,
      reminder_hours: hours
    };

    if (existsIndex === -1) {
      subs.push(newSubData);
      console.log('[JSON] Nueva suscripción guardada localmente.');
    } else {
      subs[existsIndex] = newSubData;
      console.log('[JSON] Suscripción actualizada localmente.');
    }
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
  }
}

async function removeSubscription(endpoint) {
  if (dbPool) {
    try {
      await dbPool.query('DELETE FROM subscriptions WHERE endpoint = $1', [endpoint]);
      console.log('[DB] Suscripción removida de Postgres.');
    } catch (err) {
      console.error('Error al eliminar suscripción de PostgreSQL:', err);
    }
  } else {
    if (!fs.existsSync(SUBS_FILE)) return;
    try {
      let subs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
      subs = subs.filter(s => s.endpoint !== endpoint);
      fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
      console.log('[JSON] Suscripción removida localmente.');
    } catch (e) {}
  }
}

// --- 4. Broadcast Push Notifications helper ---
async function sendPushNotification(payload) {
  const subscriptions = await getSubscriptions();
  console.log(`[Push] Enviando notificación a ${subscriptions.length} suscriptores.`);
  
  const pushPromises = subscriptions.map((sub, index) => {
    return webpush.sendNotification(sub, JSON.stringify(payload))
      .catch(async err => {
        // Remove expired subscriptions (410 Gone / 404 Not Found)
        if (err.statusCode === 410 || err.statusCode === 404) {
          console.log(`[Push] Suscripción #${index} expirada/inválida. Removiendo.`);
          await removeSubscription(sub.endpoint);
        } else {
          console.error(`[Push] Error enviando a suscripción #${index}:`, err.message);
        }
        return null;
      });
  });

  await Promise.all(pushPromises);
}

// --- 5. API Endpoints ---
app.get('/', (req, res) => {
  res.send('API de Diario de Emociones está activa.');
});

// Endpoint to check if client lock is required
app.get('/api/pin-required', (req, res) => {
  const hasPin = !!process.env.APP_PIN;
  res.json({ required: hasPin });
});

// Endpoint to verify security PIN
app.post('/api/verify-pin', (req, res) => {
  const userPin = req.body.pin;
  const correctPin = process.env.APP_PIN;

  if (!correctPin) {
    // If no PIN is configured on the server, auto-unlock
    return res.json({ success: true });
  }

  if (userPin === correctPin) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'PIN incorrecto.' });
  }
});

// Serve VAPID public key
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// Subscribe to push notifications
app.post('/api/subscribe', async (req, res) => {
  const subscription = req.body;
  
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Suscripción inválida.' });
  }

  await addSubscription(subscription);
  res.status(201).json({ message: 'Suscrito con éxito.' });
});

// Unsubscribe from push notifications
app.post('/api/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  
  if (!endpoint) {
    return res.status(400).json({ error: 'Falta endpoint.' });
  }

  await removeSubscription(endpoint);
  res.status(200).json({ message: 'Desuscrito con éxito.' });
});

// Trigger push test
app.post('/api/trigger-push', async (req, res) => {
  const { title, body } = req.body;
  
  const payload = {
    title: title || '¿Cómo te sentís hoy?',
    body: body || 'Es hora de registrar tu humor. ¡Toca un emoji!'
  };

  try {
    await sendPushNotification(payload);
    res.json({ success: true, message: 'Notificación push enviada.' });
  } catch (err) {
    console.error('[API] Error al disparar push:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- 6. Cron Job Scheduling (Hourly check of custom times) ---
cron.schedule('0 * * * *', async () => {
  const currentHour = new Date().getHours();
  console.log(`⏰ [Cron] Verificando recordatorios para la hora actual local: ${currentHour}:00`);

  try {
    const subscriptions = await getSubscriptions();
    const targetSubscriptions = subscriptions.filter(sub => {
      const hours = sub.reminder_hours || [10, 20];
      return hours.includes(currentHour);
    });

    if (targetSubscriptions.length === 0) return;

    console.log(`[Cron] Enviando notificaciones push a ${targetSubscriptions.length} suscriptores...`);
    const payload = {
      title: '¿Cómo te sentís ahora?',
      body: 'Es hora de tu registro diario. ¿Nos contás cómo va tu día?'
    };

    const pushPromises = targetSubscriptions.map((sub, index) => {
      return webpush.sendNotification(sub, JSON.stringify(payload))
        .catch(async err => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            console.log(`[Push] Suscripción obsoleta detectada. Removiendo.`);
            await removeSubscription(sub.endpoint);
          } else {
            console.error('[Push] Error al enviar notificación:', err.message);
          }
          return null;
        });
    });

    await Promise.all(pushPromises);
  } catch (err) {
    console.error('Error en ejecución del Cron horaria:', err);
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 API de Mood Tracker corriendo en http://localhost:${PORT}`);
  console.log(`⏰ Cron programado para verificar recordatorios personalizados cada hora (00 minutos).`);
});
