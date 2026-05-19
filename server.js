import express from 'express';
import cors from 'cors';
import webpush from 'web-push';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve directory paths in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for frontend clients (including localhost dev and production)
app.use(cors({
  origin: '*', // Allow any origin to connect, or list specific URL when deployed
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Files for local persistence
const VAPID_FILE = path.join(__dirname, 'vapid.json');
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');

// 1. Setup VAPID Keys
let vapidKeys;
if (fs.existsSync(VAPID_FILE)) {
  try {
    vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    console.log('🔑 Loaded existing VAPID keys from vapid.json');
  } catch (err) {
    console.error('Error loading vapid.json, regenerating keys.', err);
  }
}

if (!vapidKeys) {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
  console.log('✅ Generated new VAPID keys in vapid.json');
}

webpush.setVapidDetails(
  'mailto:lucas@example.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// 2. Subscription Storage Helpers
function getSubscriptions() {
  if (!fs.existsSync(SUBS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
  } catch (err) {
    console.error('Error reading subscriptions file, returning empty array', err);
    return [];
  }
}

function saveSubscriptions(subs) {
  try {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
  } catch (err) {
    console.error('Error saving subscriptions', err);
  }
}

// 3. Broadcast Push Notifications helper
function sendPushNotification(payload) {
  const subscriptions = getSubscriptions();
  console.log(`[Push] Enviando notificación a ${subscriptions.length} suscriptores.`);
  
  const pushPromises = subscriptions.map((sub, index) => {
    return webpush.sendNotification(sub, JSON.stringify(payload))
      .catch(err => {
        // If subscription expired (410) or not found (404), flag it for removal
        if (err.statusCode === 410 || err.statusCode === 404) {
          console.log(`[Push] Suscripción #${index} expirada/inválida. Removiendo.`);
          return { expired: true, endpoint: sub.endpoint };
        }
        console.error(`[Push] Error enviando a suscripción #${index}:`, err.message);
        return null;
      });
  });

  return Promise.all(pushPromises).then(results => {
    const expiredEndpoints = results
      .filter(res => res && res.expired)
      .map(res => res.endpoint);

    if (expiredEndpoints.length > 0) {
      let current = getSubscriptions();
      current = current.filter(sub => !expiredEndpoints.includes(sub.endpoint));
      saveSubscriptions(current);
      console.log(`[Push] Limpieza completa. Se borraron ${expiredEndpoints.length} suscripciones expiradas.`);
    }
  });
}

// 4. API Endpoints
app.get('/', (req, res) => {
  res.send('Mood Tracker API Server is Running.');
});

// Serve public key for frontend to register subscription
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// Subscribe to push notifications
app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Suscripción inválida.' });
  }

  let subs = getSubscriptions();
  const exists = subs.find(s => s.endpoint === subscription.endpoint);
  
  if (!exists) {
    subs.push(subscription);
    saveSubscriptions(subs);
    console.log(`[API] Nueva suscripción registrada. Total: ${subs.length}`);
  }

  res.status(201).json({ message: 'Suscrito con éxito.' });
});

// Unsubscribe from push notifications
app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  
  if (!endpoint) {
    return res.status(400).json({ error: 'Falta endpoint.' });
  }

  let subs = getSubscriptions();
  const initialLength = subs.length;
  subs = subs.filter(s => s.endpoint !== endpoint);
  saveSubscriptions(subs);
  
  console.log(`[API] Suscripción removida. Total: ${subs.length}`);
  res.status(200).json({ message: 'Desuscrito con éxito.' });
});

// Immediate push trigger endpoint for testing
app.post('/api/trigger-push', (req, res) => {
  const { title, body } = req.body;
  
  const payload = {
    title: title || '¿Cómo te sentís hoy?',
    body: body || 'Es hora de registrar tu humor. ¡Toca un emoji!'
  };

  sendPushNotification(payload)
    .then(() => res.json({ success: true, message: 'Notificación push enviada.' }))
    .catch(err => {
      console.error('[API] Error al disparar push:', err);
      res.status(500).json({ success: false, error: err.message });
    });
});

// 5. Cron Job Scheduling (Twice a day: 10:00 AM and 8:00 PM)
// Pattern: '0 10,20 * * *' (Minute 0, Hours 10 and 20, every day)
cron.schedule('0 10,20 * * *', () => {
  console.log('⏰ [Cron] Disparando notificación diaria programada (10:00 / 20:00)');
  const payload = {
    title: '¿Cómo te sentís ahora?',
    body: 'Es hora de tu registro diario. ¿Nos contás cómo va tu día?'
  };
  sendPushNotification(payload);
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 API de Mood Tracker corriendo en http://localhost:${PORT}`);
  console.log(`⏰ Cron programado para notificaciones: 10:00 y 20:00 (hora local)`);
});
